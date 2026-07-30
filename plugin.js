/**
 * auto-bg.ts — opencode plugin — AUTO-BACKGROUND + MODEL-PRESERVING WAKE SAFETY NET
 *
 * DUE RESPONSABILITÀ, entrambe sull'hook `event`:
 *
 * 1) BACKGROUND (invariato, collaudato 688/698 deleghe, 0 POST falliti)
 *    `session.created` con parentID e parent=architect → poll finché il child è
 *    busy, poi POST /experimental/session/<parentID>/background → il parent torna
 *    IDLE subito e il turno torna ad Angelo.
 *
 * 2) WAKE SAFETY NET (nuovo, 2026-07-27)
 *    `session.idle` su un child → sorveglia il parent. Il wake NATIVO di opencode
 *    (task.ts inject → ops.prompt) ha già scritto il `<task ... state="completed">`
 *    nella timeline del parent; nella stragrande maggioranza dei casi fa partire
 *    anche il turno. Quando NON lo fa (Runner.ensureRunning scarta il work se il
 *    parent è già Running — misurato ~3% su 536 deleghe), il messaggio resta lì
 *    non risposto per sempre: niente ri-scansiona i messaggi utente in coda.
 *    Questo watchdog se ne accorge e ri-lancia il turno.
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

    try {
      const r = await fetch(`${OPENCODE_URL}/session/${parent.id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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
   * Cerca il <task id="childID" state="completed"> nei messaggi del parent.
   *
   * POSTMORTEM 2026-07-29 — la versione precedente aveva TRE bug:
   *   1. Usava m?.info?.parts (sempre vuoto) — le parti stanno in m?.parts
   *   2. Filtrava type="tool" — i task_result completati sono type="text" synthetic
   *   3. Non distingueva state="running" da state="completed"
   *   Conseguenza: restituiva sempre false → 3 wake per child → tripla notifica.
   */
  const taskResultDelivered = async (parentID, childID) => {
    const msgs = await getJson(`/session/${parentID}/message`)
    if (!Array.isArray(msgs)) return false
    const needle = `<task id="${childID}"`
    return msgs.some((m) => {
      const parts = m?.parts || []
      return parts.some((p) => {
        // Caso 1: delega iniziale (type="tool", tool="task", state="running" o "completed")
        if (p?.type === "tool" && p?.tool === "task") {
          const output = p?.state?.output || ""
          if (typeof output === "string" && output.includes(needle)) {
            // Matcha SOLO se completato, non la delega iniziale state="running"
            return output.includes(`state="completed"`)
          }
        }
        // Caso 2: notifica di completamento nativa (type="text", synthetic=true)
        if (p?.type === "text") {
          const text = p?.text || ""
          if (typeof text === "string" && text.includes(needle)) {
            return text.includes(`state="completed"`)
          }
        }
        return false
      })
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
      if (await taskResultDelivered(parent.id, childID)) {
        log(
          attempts === 0
            ? `parent ${parent.id}: task_result di child ${childID} già nella timeline (wake nativo ok)`
            : `parent ${parent.id}: task_result di child ${childID} arrivato dopo wake #${attempts}`,
        )
        return
      }

      const status = await getJson("/session/status")
      const st = status?.[parent.id]?.type
      if (st === "busy" || st === "retry") {
        // Il parent sta lavorando: il wake nativo è in coda dietro al run corrente
        // e verrà consegnato alla fine (misurato fino a 78.6s). Non toccare nulla.
        await sleep(WAKE_POLL_MS)
        continue
      }

      // Parent IDLE e nessun turno nuovo ⇒ il wake nativo è stato scartato.
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
