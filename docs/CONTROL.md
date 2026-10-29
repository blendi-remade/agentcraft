# AgentCraft Control (dashboard su :8045)

Un solo programma da avviare. Apre una dashboard nel browser da cui gestisci tutto: Foreman,
Minecraft, chat con il team, agenti, task, decisioni, diff, memoria, skill e server MCP.

```
AgentCraft.cmd          Windows: doppio clic
./agentcraft.sh         Linux
AgentCraft.command      macOS: doppio clic
node tools/control.mjs  ovunque (Node 22+)
```

La dashboard si apre su <http://127.0.0.1:8045>. Opzioni: `--port N`, `--no-open`,
`--no-autostart` (non avvia il Foreman), `--lan` (raggiungibile da telefono/tablet in rete locale,
con il link col token stampato nel terminale), `--home DIR`.

Chiudere il Control (Ctrl+C) ferma anche il Foreman che ha avviato, salvando lo stato. Minecraft
resta aperto. Se trova un Foreman già acceso per lo stesso profilo, ci si collega invece di
avviarne un altro.

## Le pagine

| Pagina | Cosa fai |
|---|---|
| **Chat** | Come Claude Code: scrivi un obiettivo per il team, oppure scegli `@agente` per un messaggio. Le decisioni aperte (domande, permessi, merge) compaiono sopra la casella con i pulsanti. Comandi: `/pause @x`, `/resume @x`, `/stop @x`, `/spawn @x [task]`, `/nudge @x`, `/answer d4 <opzione> [testo]`, `/repo add <percorso>`, `/status`. |
| **Agenti** | Stato di ogni agente, modello, task, monitor live del log. Pulsanti Pausa, Riprendi, **Sblocca**, Fuori turno / In turno. Un agente fermo da troppo tempo ha il badge rosso "fermo da N min". |
| **Task** | Kanban (da fare, in corso, revisione, fatti, bloccati): riprova, priorità, riassegna, annulla. |
| **Decisioni** | Decisioni aperte e recenti, risposta con testo libero, diff completo dei merge. |
| **Browser** | Gli indirizzi locali che gli agenti stampano (Variant Studio, server di sviluppo) compaiono come pulsanti: un clic li apre nel riquadro integrato. |
| **Permessi** | Interruttore **Consenti tutto** (nessuna richiesta di permesso, anche quelle già in attesa; `git push` resta vietato agli agenti) ed elenco delle regole "Consenti sempre" con Revoca / Revoca tutte. |
| **Memoria**, **Repo** | La biblioteca del team; repo collegate, worktree e loro diff; aggiungi una repo; **Push** e **Apri PR** (sotto). |
| **Servizi** | Avvia, ferma, riavvia, riconnetti il Foreman; avvia e chiudi Minecraft ("in attesa di Minecraft" finché il mod non si collega); impostazioni di avvio (backend, repo, worker, modello, argomenti extra); log di Foreman, Minecraft e Control. |
| **Impostazioni** | Lingua degli agenti, il tuo nome, watchdog, **modello per agente**, skill e server MCP (sotto). |

La lingua della dashboard si sceglie in alto a destra (IT/EN).

## Skill e MCP senza scrivere niente

La pagina Impostazioni legge le skill e i server MCP che hai **già** configurato per ogni AI e li
mostra come caselle da spuntare, separati per motore:

| | Skill | Server MCP |
|---|---|---|
| **Claude** | `~/.claude/skills`, `~/.agents/skills` | `~/.claude.json` (utente e progetto), `.mcp.json` della repo |
| **Codex** | `~/.codex/skills` (o `$CODEX_HOME`), `~/.agents/skills` | `[mcp_servers.*]` in `~/.codex/config.toml` |

La colonna del motore in uso è evidenziata. Nel `config.json` del Foreman finiscono solo i nomi
scelti (`claude.skills`, `claude.mcp`, `codex.skills`, `codex.mcp`), quindi se modifichi un server
nella config di Claude o Codex l'agente usa la versione aggiornata. "tutte" vale anche per quelle
che aggiungerai dopo.

- I tool dei server MCP chiedono il permesso in gioco o in dashboard, a meno che tu spunti
  "senza conferma" (solo Claude). Con Claude, i server utente che **non** hai spuntato vengono
  rifiutati anche se Claude Code li caricherebbe.
- Le skill Claude passano dal tool Skill nativo; le skill Codex vengono indicate all'agente con il
  percorso del loro `SKILL.md`. Le cartelle delle skill scelte sono leggibili senza chiedere; gli
  script che lanciano chiedono il permesso la prima volta ("Consenti sempre" li sblocca).
- In "Avanzate" restano le cartelle plugin e un campo JSON per server extra non configurati altrove.

Da riga di comando: `--skills designer --mcp playwright --trusted-mcp playwright` (Claude),
`--codex-skills all --codex-mcp github` (Codex).

### Esempio: DesignerSkill e Variant Studio

1. Installa DesignerSkill come al solito (finisce in `~/.claude/skills/designer` e
   `~/.agents/skills`).
2. Impostazioni → spunta `designer` (e `variant-studio`) nella colonna del motore che usi → Salva e
   riavvia.
3. Dai l'obiettivo in chat. Quando l'agente avvia Variant Studio, l'indirizzo compare nella pagina
   **Browser**: scegli le varianti e commenta lì. Le domande che la skill fa all'utente arrivano come
   decisioni (in dashboard e in gioco con <kbd>J</kbd>).

## Scegliere le varianti in Minecraft

Quando un agente apre un round di Variant Studio (in un worktree o nella repo), il Foreman lo
trasforma in una decisione: una opzione per variante più "Nessuna: nuove direzioni". Rispondi
come a ogni altra decisione, in gioco con <kbd>J</kbd> e un numero, oppure nel pannello, dove ogni
variante ha la sua miniatura: un clic la sceglie. Se scrivi un testo insieme alla variante,
l'agente riceve una richiesta di revisione con quel testo; solo testo = nuove direzioni. La scelta
arriva allo studio esattamente come un clic nella galleria, e se decidi nella galleria la
decisione sparisce da sola.

## Permessi

- In ogni richiesta c'è ora anche **Consenti sempre a tutti gli agenti** (oltre a "Consenti sempre a
  questo agente").
- **Consenti tutto** (pagina Permessi, oppure `"permission-mode": "allow-all"` in `config.json`,
  `--permission-mode allow-all`): nessuna richiesta, tutto accettato. Restano bloccati solo i
  comandi sempre vietati (`git push`, modifiche alla sicurezza di git, sotto-agenti).

## Modello per agente

Impostazioni → Modello per agente: per esempio `haiku` per chi scrive test, `opus` per Marlow.
Vuoto = il modello del ruolo. Vale per Claude e Codex (`"models": {"kit": "haiku"}` in
`config.json`, `--agent-models kit=haiku`).

## Push e pull request

Nella pagina Repo: **Push** manda il branch base al remote con il tuo git e le tue credenziali;
**Apri PR** crea un branch `agentcraft/publish-<data>` alla punta del branch base (se il base è
`main`), lo pusha e apre la pull request con `gh`. Senza `gh` si apre la pagina di confronto di
GitHub per crearla a mano. Parte solo con il tuo clic e una conferma; gli agenti non possono mai
pushare.

## Agenti bloccati

Il Foreman controlla ogni turno in corso: se un agente non produce nessuna attività per
`stall-minutes` (10 di default) lo segnala nel feed, con una notifica, e nella dashboard. Un turno
in attesa di una tua risposta non conta. **Sblocca** (o `/nudge @agente`, anche nella console di
gioco) termina il turno e lo riprende subito sulla stessa sessione con un promemoria. Con
"Riavvia il turno da solo" (`--stall-action nudge`) lo fa automaticamente.

## Lingua

- **Messaggi del Foreman** (feed, notifiche, richieste di permesso e di merge): in italiano con la
  stessa impostazione. Nomi, task, branch e titoli restano come sono.
- **Agenti**: Impostazioni → Lingua degli agenti (`"language": "it"` in `~/.agentcraft/config.json`,
  `--language it`). Domande, messaggi, riepiloghi e memoria arrivano in italiano.
- **Mod**: segue la stessa impostazione, oppure la lingua di Minecraft (Opzioni → Lingua →
  Italiano), oppure `AGENTCRAFT_LANG=it`. In gioco: `/lang it`, `/lang en`, `/lang auto` nella
  console. Nomi dei blocchi e tasti sono in `lang/it_it.json`, i testi delle schermate in
  `i18n/it.json` (chiave = testo inglese; ciò che manca resta in inglese).

## Sicurezza

Il Control ascolta solo su 127.0.0.1. Ogni chiamata e il WebSocket richiedono il token della
pagina, un Host locale e la stessa origine: un'altra pagina web non può pilotare i tuoi agenti.
Con `--lan` anche la pagina richiede il token (il link stampato lo contiene).
