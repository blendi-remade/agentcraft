// The Foreman's own messages (feed, toasts, permission and merge questions) in the user's language.
// The code writes English; with `language: it` each message is matched against these templates and
// rewritten. Names, task ids, branches and titles pass through untouched, so anything that looks
// for them in the text (the mod checks that a merge question names its branch) still finds them.
// A message no template matches stays English. What agents write is theirs (they are told the
// language in their instructions) and is never touched.

let lang = 'en';

export function setLanguage(l: string): void {
  lang = l;
}

export function language(): string {
  return lang;
}

type Rule = [RegExp, string | ((...m: string[]) => string)];

const STATUS_IT: Record<string, string> = { todo: 'da fare', doing: 'in corso', review: 'revisione', done: 'fatto', blocked: 'bloccato', cancelled: 'annullato' };
const ACTION_IT: Record<string, string> = { pause: 'in pausa', resume: 'ripreso', stop: 'fuori turno', spawn: 'in turno', nudge: 'sbloccato' };
const KIND_IT: Record<string, string> = { question: 'domanda', permission: 'permesso', 'merge review': 'revisione merge' };

const IT: Rule[] = [
  [/^(.+?) answered (\S+): ([\s\S]*)$/, '$1 ha risposto a $2: $3'],
  [/^(.+?) picked for (\S+): ([\s\S]*)$/, '$1 ha scelto per $2: $3'],
  [/^(\S+) needs you \((question|permission|merge review)\): ([\s\S]*)$/, (_, who, k, q) => `${who} ti cerca (${KIND_IT[k!]}): ${localize(q!)}`],
  [/^(\S+) shows no activity for (\d+) min - restarting the turn$/, '$1 non mostra attività da $2 min - riavvio il turno'],
  [/^(\S+) shows no activity for (\d+) min - (\/nudge @\S+) to restart the turn$/, '$1 non mostra attività da $2 min - $3 per riavviare il turno'],
  [/^(\S+) seems stuck: no activity for (\d+) min$/, '$1 sembra bloccato: nessuna attività da $2 min'],
  [/^(\S+)'s planning turn ended without tasks([\s\S]*)$/, 'Il turno di pianificazione di $1 è finito senza task$2'],
  [/^Merge refused: ([\s\S]*)$/, 'Merge rifiutato: $1'],
  [/^Goal closed: every task was cancelled or rejected \(([\s\S]*)\)$/, 'Obiettivo chiuso: ogni task è stato annullato o rifiutato ($1)'],
  [/^Goal complete: ([\s\S]*)$/, 'Obiettivo completato: $1'],
  [/^(\S+) planned no tasks: goal closed \(([\s\S]*)\)$/, '$1 non ha pianificato task: obiettivo chiuso ($2)'],
  [/^New goal: ([\s\S]*)$/, 'Nuovo obiettivo: $1'],
  [/^(t\d+) conflicts with (\S+): sent back to (\S+) to resolve$/, '$1 va in conflitto con $2: rimandato a $3 per risolverlo'],
  [/^(t\d+) conflicts with (\S+) in (.+): (\S+) merges \S+ and resolves it$/, '$1 va in conflitto con $2 in $3: $4 unisce $2 e risolve'],
  [/^(t\d+) had no changes: closed as done$/, '$1 non aveva modifiche: chiuso come fatto'],
  [/^Merged (\S+) into (\S+) \((\w+), (\d+) files?\)$/, 'Unito $1 in $2 ($3, $4 file)'],
  [/^Merged (\S+) into (\S+)$/, 'Unito $1 in $2'],
  [/^Nothing to merge for (t\d+) \(no file changes\): closed as done$/, 'Niente da unire per $1 (nessun file modificato): chiuso come fatto'],
  [/^Rejected (\S+) \(branch kept for recovery\)$/, 'Rifiutato $1 (il branch resta per un eventuale recupero)'],
  [/^(\S+) wrote memory: ([\s\S]*)$/, '$1 ha scritto in memoria: $2'],
  [/^(.+?) pushed (\S+) to (\S+): pull request (\S+)$/, '$1 ha pushato $2 su $3: pull request $4'],
  [/^(.+?) pushed (\S+) to (\S+) \(open the pull request: (\S+)\)$/, '$1 ha pushato $2 su $3 (apri la pull request: $4)'],
  [/^(.+?) pushed (\S+) to (\S+)$/, '$1 ha pushato $2 su $3'],
  [/^(.+?) turned on allow-all: agents no longer ask for permission \(git push stays refused\)$/, '$1 ha attivato "consenti tutto": gli agenti non chiedono più il permesso (git push resta vietato)'],
  [/^(.+?) turned off allow-all: agents ask again$/, '$1 ha disattivato "consenti tutto": gli agenti chiedono di nuovo'],
  [/^(\S+) planned the goal into (\d+) tasks?( \(picked up after a restart\))?$/, (_, who, n, again) => `${who} ha diviso l'obiettivo in ${n} task${again ? ' (ripreso dopo un riavvio)' : ''}`],
  [/^(\S+) planned ([\s\S]+) into (\d+) tasks$/, '$1 ha diviso $2 in $3 task'],
  [/^Marlow is back on shift for the new goal$/, 'Marlow è di nuovo in turno per il nuovo obiettivo'],
  [/^(\S+) is back on shift$/, '$1 è di nuovo in turno'],
  [/^(\S+): (pause|resume|stop|spawn|nudge)((?: \S+)?)$/, (_, who, a, arg) => `${who}: ${ACTION_IT[a!]}${arg}`],
  [/^Fetching (\d+) pull requests? from GitHub$/, 'Scarico $1 pull request da GitHub'],
  [/^Repo connected: ([\s\S]*)$/, 'Repo collegata: $1'],
  [/^(t\d+) and (t\d+) are unblocked$/, '$1 e $2 sono sbloccati'],
  [/^(\S+): (t\d+) (\w+) -> (\w+)$/, (_, who, t, a, b) => `${who}: ${t} ${STATUS_IT[a!] ?? a} -> ${STATUS_IT[b!] ?? b}`],
  [/^(t\d+) changed no files \(report only\): closed as done, nothing to merge$/, '$1 non ha modificato file (solo un report): chiuso come fatto, niente da unire'],
  [/^(t\d+) is back on the board \((\S+) was stopped\)$/, '$1 torna in bacheca ($2 è stato fermato)'],
  [/^(\S+) continues (t\d+) from (\S+)'s branch$/, '$1 continua $2 dal branch di $3'],
  [/^(\S+) finished (t\d+) -> review$/, '$1 ha finito $2 -> revisione'],
  [/^(\S+) started (t\d+): ([\s\S]*)$/, '$1 ha iniziato $2: $3'],
  [/^(\S+) created (t\d+): ([\s\S]*)$/, '$1 ha creato $2: $3'],
  [/^Task (t\d+) cancelled by (.+?): ([\s\S]*)$/, 'Task $1 annullato da $2: $3'],
  [/^Task (t\d+) priority -> (-?\d+)$/, 'Task $1 priorità -> $2'],
  [/^Task (t\d+) queued again: ([\s\S]*)$/, 'Task $1 di nuovo in coda: $2'],
  [/^Task (t\d+) reassigned to (\S+)$/, 'Task $1 riassegnato a $2'],
  [/^(\S+) is blocked on (t\d+): ([\s\S]*)$/, '$1 è bloccato su $2: $3'],
  [/^(\S+): (t\d+) failed \(([\s\S]*)\) - (\/task \S+ retry) when ready$/, '$1: $2 fallito ($3) - $4 quando sei pronto'],
  [/^(\S+): (t\d+) is blocked \(([\s\S]*)\) - (\/task \S+ retry) when ready$/, '$1: $2 è bloccato ($3) - $4 quando sei pronto'],
  [/^(t\d+): tests (pass|fail) \(([\s\S]*)\)$/, (_, t, r, c) => `${t}: test ${r === 'pass' ? 'superati' : 'falliti'} (${c})`],
  [/^(\S+): tests (pass|fail)( on t\d+)?( \([\s\S]*\))?$/, (_, who, r, on, s) => `${who}: test ${r === 'pass' ? 'superati' : 'falliti'}${on ? on.replace(' on ', ' su ') : ''}${s ?? ''}`],
  // questions the Foreman asks on the agents' behalf
  [/^(\S+) wants to run ([\s\S]+)$/, '$1 vuole eseguire $2'],
  [/^Merge (t\d+) "([\s\S]*)" \((\S+)\) into (\S+)\?$/, 'Unire $1 "$2" ($3) in $4?'],
];

/** The message in the current language (English when it has no template). */
export function localize(text: string): string {
  if (lang !== 'it') return text;
  for (const [re, to] of IT) {
    const m = re.exec(text);
    if (!m) continue;
    return typeof to === 'string' ? text.replace(re, to) : to(...(m as unknown as string[]));
  }
  // "Kit: <question>" toasts: the question part
  const who = /^([A-Z][\w-]*): ([\s\S]+)$/.exec(text);
  if (who) {
    const rest = localize(who[2]!);
    if (rest !== who[2]) return `${who[1]}: ${rest}`;
  }
  return text;
}
