/**
 * auto-bg.ts — opencode plugin — AUTO-BACKGROUND + MODEL-PRESERVING WAKE SAFETY NET + TODO-SYNC NUDGE
 *
 * TRE RESPONSABILITÀ, tutte sull'hook `event`:
 *
 * 1) BACKGROUND (invariato, collaudato 688/698 deleghe, 0 POST falliti)
 *    `session.created` con parentID e parent=architect → poll finché il child è
 *    busy, poi POST /experimental/session/<parentID>/background → il parent torna
 *    IDLE subito e il turno torna ad Angelo.
 *
 * 2) WAKE SAFETY NET (nuovo, 2026-07-27; esteso 2026-08-03)
 *    `session.idle` su un child → sorveglia il parent. Il wake NATIVO di opencode
 *    (task.ts inject → ops.prompt) ha già scritto il `<task ... state="completed">`
 *    nella timeline del parent; nella stragrande maggioranza dei casi fa partire
 *    anche il turno. Quando NON lo fa (Runner.ensureRunning scarta il work se il
 *    parent è già Running — misurato ~3% su 536 deleghe), il messaggio resta lì
 *    non risposto per sempre: niente ri-scansiona i messaggi utente in coda.
 *    Questo watchdog se ne accorge e ri-lancia il turno.
 *    INCIDENTE 2026-08-03 (anomalyco#33066/#21524): il wake nativo può consegnare
 *    il result ma il turno del parent muore a metà (step-finish reason="unknown",
 *    0 token, nessun errore) e la sessione resta idle per ore. Da questa versione
 *    il watchdog verifica la COMPLETION del turno post-iniezione, non solo la
 *    delivery, e usa /session/{id}/message (sync) al posto di prompt_async (che
 *    su sessioni idle spesso non fa partire il turno).
 *
 * REGOLA D'ORO — NESSUN PIN DI MODELLO.
 *    Il wake DEVE girare con lo STESSO modello del turno precedente del parent,
 *    altrimenti si perde tutta la cache di prompt e si cambia modello sotto i piedi
 *    dell'utente (che magari lo aveva pinnato per quella sessione). Quindi:
 *      - `architect.md` non dichiara né `model:` né `variant:` (rimossi 2026-07-27);
 *      - qui leggiamo il providerID/modelID dall'ULTIMO assistant message REALE del
 *        parent e lo passiamo esplicito nel body del wake.
 *    "Reale" = `info.agent === parent.agent`. Serve a scartare i messaggi generati
 *    dallo small_model (agent `compaction`/`title`/`summary`, es. xiaomi/mimo-v2.5):
 *    ereditare quello pinnerebbe il wake sul generatore di titoli.
 *    Se non troviamo un turno reale, OMETTIAMO `model` — così opencode eredita da
 *    solo il modello di sessione. Meglio nessun pin che un pin sbagliato.
 *
 * TRAPPOLE DELL'API (pagate care il 26-27 luglio, non ripeterle):
 *    - `POST /session/{id}/prompt` NON ESISTE. Le rotte vere sono
 *      `/session/{id}/message` (v1 sync), `/session/{id}/prompt_async` (v1 async),
 *      `/api/session/{id}/prompt` (v2 durable). I plugin nuked usavano la prima.
 *    - Ogni path non matchato risponde **200 text/html** (la SPA, 2884 byte), MAI 404.
 *      Perciò ogni risposta va validata su content-type prima di fidarsi.
 *    - `session.idle` porta SOLO `{sessionID}`: nessun parentID. Va risolto con GET.
 *    - console.log di un plugin finisce in `journalctl -u opencode.service`,
 *      NON in ~/.local/share/opencode/log/opencode.log.
 *
 * Scope: solo deleghe il cui parent è `architect`. `build` e gli altri primari
 * restano intatti.
 *
 * 3) TODO-SYNC NUDGE (fork 2026-08-06; state-based 2026-08-06 v1.2.0)
 *    `session.idle` su una sessione TOP-LEVEL con agent=architect (il parent stesso,
 *    NON un child) → se la TODO ha task ancora `in_progress`, inietta un promemoria
 *    meccanico a sincronizzarla. STATE-BASED, non tool-call-based: l'euristica
 *    precedente ("ultimo turno ha usato tool senza todowrite") mancava i turni
 *    text-only — il turno finale che dichiara "fatto" con in_progress pendenti.
 *    Grace: se c'è una delega in volo (child busy) gli in_progress sono legittimi.
 *    Convergence: se l'ultimo turno ha già chiamato `todowrite`, non insistere.
 *    Cooldown 2min anti-loop. Questo rende la regola "TODO aggiornati a fine OGNI
 *    turno" un trigger di sistema, non un'autodisciplina.
 */

const OPENCODE_URL = "http://127.0.0.1:4097"
const TRIGGER_PARENT_AGENT = "architect"

const POLL_MS = 200 // poll del child in fase di background
const POLL_MAX_MS = 10000 // finestra massima per vedere il child busy
const HTTP_TIMEOUT_MS = 3000

const WAKE_GRACE_MS = 4000 // quanto lasciamo al wake nativo prima di guardare
const WAKE_POLL_MS = 2000 // cadenza di sorveglianza del parent
const WAKE_MAX_WAIT_MS = 300000 // 5 min: copre parent occupati a lungo (max osservato 78.6s)
const WAKE_MAX_ATTEMPTS = 3 // ri-lanci prima di arrendersi
const WAKE_POST_TIMEOUT_MS = 30000 // wake via /message sync: quanto aspettiamo la risposta (30s)

const TODO_NUDGE_COOLDOWN_MS = 120000 // 2 min: niente doppio nudge ravvicinato
const todoNudged = new Set() // sessionID già nudgati (cooldown)
const childrenByParent = new Map() // parentID -> Set(childID) — per la grace di delega nel nudge

const backgrounded = new Set() // childID già backgroundati
const waked = new Set() // childID per cui il watchdog ha già girato

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => {
  try {
    console.log(`[auto-bg] ${m}`)
  } catch {
    /* noop */
  }
}

export default async () => {
  log("plugin caricato (background deleghe architect + wake safety net model-preserving)")

  /** GET che si difende dalla SPA: un path inesistente torna 200 text/html, non 404. */
  const getJson = async (path) => {
    try {
      const r = await fetch(`${OPENCODE_URL}${path}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!r.ok) return null
      const ct = r.headers.get("content-type") || ""
      if (!ct.includes("application/json")) {
        log(`WARN: ${path} ha risposto ${r.status} ${ct} — rotta inesistente?`)
        return null
      }
      return await r.json()
    } catch {
      return null
    }
  }

  /** Solo i turni veri del parent: esclude compaction/title/summary (small_model). */
  const realAssistantMessages = async (parentID, parentAgent) => {
    const msgs = await getJson(`/session/${parentID}/message`)
    if (!Array.isArray(msgs)) return null
    return msgs.filter((m) => m?.info?.role === "assistant" && m?.info?.agent === parentAgent)
  }

  /**
   * Il modello dell'ultimo turno REALE del parent. È questo che il wake deve
   * riusare: stesso provider/modello del turno precedente, cache intatta.
   * null ⇒ omettiamo il campo e lasciamo ereditare opencode.
   */
  const lastTurnModel = (reals) => {
    for (let i = reals.length - 1; i >= 0; i--) {
      const info = reals[i]?.info
      if (info?.providerID && info?.modelID) {
        return { providerID: info.providerID, modelID: info.modelID }
      }
    }
    return null
  }

  const postWake = async (parent, model, childID) => {
    const body = {
      agent: parent.agent,
      parts: [
        {
          type: "text",
          synthetic: true,
          text:
            `[auto-bg] Il subagent \`${childID}\` ha completato e il wake nativo non è partito. ` +
            `Il suo \`<task_result>\` è già in timeline qui sopra: leggilo e prosegui da lì.`,
        },
      ],
    }
    // Nessun modello trovato ⇒ campo OMESSO: opencode eredita quello di sessione.
    // Mai un default nostro, mai un pin: cambierebbe modello sotto il parent.
    if (model) body.model = model

    // Route: /message sync (v1) e NON prompt_async — incidente 2026-08-03 + anomalyco#21524:
    // prompt_async torna 204 ma spesso non fa partire il turno su sessioni idle. Il
    // wake sync parte sempre; il timeout corto ci fa solo smettere di aspettare, il
    // turno resta in esecuzione lato server.
    try {
      const r = await fetch(`${OPENCODE_URL}/session/${parent.id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WAKE_POST_TIMEOUT_MS),
      })
      const ct = r.headers.get("content-type") || ""
      if (!r.ok || ct.includes("text/html")) {
        log(`wake POST sospetto: status=${r.status} ct=${ct} — rotta sbagliata?`)
        return false
      }
      log(
        `wake inviato a parent ${parent.id} per child ${childID} ` +
          `(model=${model ? `${model.providerID}/${model.modelID}` : "ereditato dalla sessione"})`,
      )
      return true
    } catch (e) {
      log(`wake POST fallito: ${String(e)}`)
      return false
    }
  }

  /**
   * Cerca il <task id="childID" state="completed"> nei messaggi del parent e
   * restituisce il TIMESTAMP (ms) del messaggio che lo contiene, oppure null.
   * Serve a distinguere "result consegnato" (c'è) da "turno completato" (vedi
   * parentTurnCompletedAfter) — incidente 2026-08-03: il wake nativo ha scritto il
   * result, il turno del parent è morto a metà (step-finish reason="unknown", 0
   * token) e la sessione è rimasta idle 6h. Delivery ≠ completion (anomalyco#33066).
   *
   * POSTMORTEM 2026-07-29 — la versione precedente aveva TRE bug:
   *   1. Usava m?.info?.parts (sempre vuoto) — le parti stanno in m?.parts
   *   2. Filtrava type="tool" — i task_result completati sono type="text" synthetic
   *   3. Non distingueva state="running" da state="completed"
   *   Conseguenza: restituiva sempre false → 3 wake per child → tripla notifica.
   */
  const taskResultDeliveredAt = async (parentID, childID) => {
    const msgs = await getJson(`/session/${parentID}/message`)
    if (!Array.isArray(msgs)) return null
    const needle = `<task id="${childID}"`
    for (const m of msgs) {
      const parts = m?.parts || []
      for (const p of parts) {
        let hit = false
        // Caso 1: delega iniziale (type="tool", tool="task", state="running" o "completed")
        if (p?.type === "tool" && p?.tool === "task") {
          const output = p?.state?.output || ""
          if (typeof output === "string" && output.includes(needle)) {
            hit = output.includes(`state="completed"`)
          }
        }
        // Caso 2: notifica di completamento nativa (type="text", synthetic=true)
        if (!hit && p?.type === "text") {
          const text = p?.text || ""
          if (typeof text === "string" && text.includes(needle)) {
            hit = text.includes(`state="completed"`)
          }
        }
        if (hit) return m?.info?.time?.created ?? m?.time?.created ?? m?.time_created ?? Date.now()
      }
    }
    return null
  }

  /**
   * Vero se il parent ha prodotto un turno assistant COMPLETATO dopo `afterMs`
   * (ms): un messaggio con testo reale (non sintetico auto-bg) o una tool call.
   * Un turno morto ha solo step-start/step-finish (reason="unknown") + reasoning,
   * senza text né tool — questo check lo distingue da un turno riuscito.
   */
  const parentTurnCompletedAfter = async (parentID, parentAgent, afterMs) => {
    const msgs = await getJson(`/session/${parentID}/message`)
    if (!Array.isArray(msgs)) return false
    return msgs.some((m) => {
      if (m?.info?.role !== "assistant" || m?.info?.agent !== parentAgent) return false
      const t = m?.info?.time?.created ?? m?.time?.created ?? m?.time_created
      if (!t || t < afterMs) return false
      const parts = m?.parts || []
      return parts.some(
        (p) =>
          (p?.type === "text" &&
            typeof p?.text === "string" &&
            p.text.trim().length > 0 &&
            !p.text.startsWith("[auto-bg]")) ||
          (p?.type === "tool" && !!p?.tool),
      )
    })
  }

  /**
   * Sorveglia il parent dopo che un child è finito.
   * Interviene SOLO se il parent è idle e non ha prodotto nulla di nuovo — così
   * non litighiamo mai col wake nativo (l'errore che ha ucciso i tre plugin
   * precedenti: iniettavano in parallelo e duplicavano il task_result).
   */
  const watchParent = async (childID, parent) => {
    await sleep(WAKE_GRACE_MS)

    const deadline = Date.now() + WAKE_MAX_WAIT_MS
    let attempts = 0

    while (Date.now() < deadline) {
      const deliveredAt = await taskResultDeliveredAt(parent.id, childID)
      const status = await getJson("/session/status")
      const st = status?.[parent.id]?.type

      if (deliveredAt) {
        // Il wake nativo ha scritto il result. Se il parent sta ancora lavorando,
        // il turno è in corso (misurato fino a 78.6s): aspetta, non toccare.
        if (st === "busy" || st === "retry") {
          await sleep(WAKE_POLL_MS)
          continue
        }
        // Parent IDLE con result consegnato: verifica che il turno sia DAVVERO
        // completato (incidente 2026-08-03: result consegnato ma step morto a metà,
        // reason="unknown" 0 token — delivery ≠ completion, anomalyco#33066/#21524).
        if (await parentTurnCompletedAfter(parent.id, parent.agent, deliveredAt)) {
          log(
            attempts === 0
              ? `parent ${parent.id}: task_result di child ${childID} consegnato e turno completato (wake nativo ok)`
              : `parent ${parent.id}: turno di child ${childID} completato dopo wake #${attempts}`,
          )
          return
        }
        // Result consegnato ma turno morto → stesso trattamento di un wake mancato.
        log(`parent ${parent.id}: task_result di child ${childID} consegnato ma turno NON completato → wake`)
      } else if (st === "busy" || st === "retry") {
        // Result non ancora arrivato e parent occupato: wake nativo in coda.
        await sleep(WAKE_POLL_MS)
        continue
      }

      // Parent IDLE: o il wake nativo è stato scartato, o il turno è morto.
      if (attempts >= WAKE_MAX_ATTEMPTS) {
        log(`parent ${parent.id}: ${attempts} tentativi falliti per child ${childID}, mi fermo`)
        return
      }
      attempts++
      // FIX: `reals` non esiste in questo scope (ReferenceError a ogni wake).
      // I turni reali vanno riletti adesso, che e' anche la semantica giusta:
      // il wake deve riusare il modello dell'ULTIMO turno del parent.
      const model = lastTurnModel((await realAssistantMessages(parent.id, parent.agent)) || [])
      log(`parent ${parent.id} idle senza risposta → wake #${attempts} per child ${childID}`)
      await postWake(parent, model, childID)
      await sleep(WAKE_POLL_MS)
    }
    log(`parent ${parent.id}: watchdog scaduto per child ${childID}`)
  }

  /**
   * TODO-SYNC NUDGE — sessione top-level architect andata idle.
   * STATE-BASED (v1.1.2): legge la TODO vera via GET /session/{id}/todo e nudge
   * se ci sono task `in_progress`, con due guardie:
   *  - delega in volo (child busy) → in_progress legittimi, niente nudge;
   *  - convergence: ultimo turno ha già chiamato `todowrite` → niente nudge.
   * Iniezione col meccanismo del wake: /session/{id}/message sync, modello del
   * turno precedente, synthetic text.
   */
  const maybeNudgeTodo = async (sessionID) => {
    if (todoNudged.has(sessionID)) return
    const sess = await getJson(`/session/${sessionID}`)
    if (!sess || sess.agent !== TRIGGER_PARENT_AGENT) return // solo architect top-level
    if (sess.parentID) return // child: gestito dal watchdog, non qui

    // STATE-BASED: la TODO vera, non i tool call dell'ultimo turno.
    // (2026-08-06: l'euristica "tool senza todowrite" mancava i turni text-only —
    // il turno finale che dichiara "fatto" con in_progress pendenti.)
    const todos = await getJson(`/session/${sessionID}/todo`)
    if (!Array.isArray(todos)) return
    const inProgress = todos.filter((t) => t?.status === "in_progress")
    if (inProgress.length === 0) return

    // GRACE: se c'è una delega in volo (child busy), gli in_progress sono legittimi.
    const kids = childrenByParent.get(sessionID)
    if (kids && kids.size > 0) {
      const status = await getJson("/session/status")
      if (status) {
        for (const cid of kids) {
          const st = status?.[cid]?.type
          if (st === "busy" || st === "retry") return // child attivo: aspetta
        }
      }
    }

    // CONVERGENCE: se l'ultimo turno ha già chiamato todowrite, il modello sta
    // gestendo la TODO (o ha scelto di lasciarla in_progress) — non insistere.
    const reals = (await realAssistantMessages(sessionID, TRIGGER_PARENT_AGENT)) || []
    const last = reals[reals.length - 1]
    const didTodo = last?.parts?.some((p) => p?.type === "tool" && p?.tool === "todowrite")
    if (didTodo) return

    todoNudged.add(sessionID)
    setTimeout(() => todoNudged.delete(sessionID), TODO_NUDGE_COOLDOWN_MS)
    const model = lastTurnModel(reals)
    const body = {
      agent: TRIGGER_PARENT_AGENT,
      parts: [
        {
          type: "text",
          synthetic: true,
          text:
            `[todo-sync] La sessione è andata idle con ${inProgress.length} task ancora in_progress nella TODO. ` +
            `Se il lavoro è finito, chiama \`todowrite\` per chiuderli (completed/cancelled) PRIMA di rispondere.`,
        },
      ],
    }
    if (model) body.model = model
    try {
      const r = await fetch(`${OPENCODE_URL}/session/${sessionID}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WAKE_POST_TIMEOUT_MS),
      })
      const ct = r.headers.get("content-type") || ""
      if (!r.ok || ct.includes("text/html")) {
        log(`todo-nudge POST sospetto: status=${r.status} ct=${ct}`)
        return
      }
      log(`todo-sync: nudge inviato a ${sessionID} (${inProgress.length} task in_progress)`)
    } catch (e) {
      log(`todo-nudge POST fallito: ${String(e)}`)
    }
  }

  return {
    event: async ({ event }) => {
      try {
        // ---------------------------------------------------------------
        // 1) BACKGROUND: il turno deve tornare subito ad Angelo
        // ---------------------------------------------------------------
        if (event?.type === "session.created") {
          const child = event?.properties?.info
          const childID = child?.id || event?.properties?.sessionID
          const parentID = child?.parentID
          if (!parentID || !childID) return // sessione top-level, non è una delega

          log(`session.created child=${childID} parent=${parentID} childAgent=${child?.agent || "?"}`)
          if (backgrounded.has(childID)) return
          if (backgrounded.size > 2000) backgrounded.clear()
          backgrounded.add(childID)
          const kids = childrenByParent.get(parentID) || new Set()
          kids.add(childID)
          childrenByParent.set(parentID, kids)
          if (childrenByParent.size > 200) childrenByParent.clear()

          const parent = await getJson(`/session/${parentID}`)
          if (parent?.agent !== TRIGGER_PARENT_AGENT) {
            log(`skip: parent ${parentID} agent=${parent?.agent} (≠ ${TRIGGER_PARENT_AGENT})`)
            return
          }

          const deadline = Date.now() + POLL_MAX_MS
          while (Date.now() < deadline) {
            const status = await getJson("/session/status")
            const st = status?.[childID]?.type
            if (st === "busy" || st === "retry") {
              try {
                const r = await fetch(`${OPENCODE_URL}/experimental/session/${parentID}/background`, {
                  method: "POST",
                  signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
                })
                log(
                  r.ok
                    ? `backgrounded child ${childID} (parent ${parentID} → idle, turno all'utente)`
                    : `POST background → ${r.status}`,
                )
              } catch (e) {
                log(`POST background fallita: ${String(e)}`)
              }
              return
            }
            await sleep(POLL_MS)
          }
          log(`child ${childID}: mai busy entro ${POLL_MAX_MS}ms — nessun background (nessun danno)`)
          return
        }

        // ---------------------------------------------------------------
        // 2) WAKE SAFETY NET: il child ha finito, il parent deve accorgersene
        // ---------------------------------------------------------------
        if (event?.type === "session.idle") {
          // session.idle porta SOLO sessionID: il parentID va risolto con una GET.
          const sessionID = event?.properties?.sessionID || event?.properties?.info?.id
          if (!sessionID) return
          // Sessione top-level (architect stesso): nudge TODO se il turno ha usato tool senza todowrite
          const maybeSess = await getJson(`/session/${sessionID}`)
          if (maybeSess && !maybeSess.parentID) {
            maybeNudgeTodo(sessionID).catch((e) => log(`todo-nudge err: ${String(e)}`))
            return
          }
          if (waked.has(sessionID)) return
          // FIX 2026-07-29: waked.add PRIMA degli await per chiudere la race condition
          // (due eventi ravvicinati entravano entrambi prima che il primo facesse l'add)
          if (waked.size > 2000) waked.clear()
          waked.add(sessionID)

          const child = await getJson(`/session/${sessionID}`)
          const parentID = child?.parentID
          if (!parentID) return // sessione top-level: non è un child

          const parent = await getJson(`/session/${parentID}`)
          if (parent?.agent !== TRIGGER_PARENT_AGENT) return

          log(`child ${sessionID} idle → sorveglio parent ${parentID}`)

          // fire-and-forget: non blocchiamo il bus degli eventi
          watchParent(sessionID, parent).catch((e) => log(`watchdog err: ${String(e)}`))
        }
      } catch (err) {
        log(`event err: ${String(err)}`)
      }
    },
  }
}
