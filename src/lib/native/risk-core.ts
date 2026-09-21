/**
 * Which tasks always need a person's yes, even with a standing rule ("risky-only" approvals). Pure and measured: the rule
 * is scored against the labeled lists in scripts/fixtures, and a change that lowers the score must not ship.
 *
 * This is a heuristic first brake, not a guarantee: the agent that receives a task still has its own permission prompts.
 * Shape: a clause that only reads, explains, reviews, drafts or writes code is safe; otherwise it is risky when it names
 * an action in one of seven categories against something that matters. Owner decisions (2026-09-21): outside = only
 * SENDING asks; money = anything that moves or commits money; shipping = any push or merge, anywhere.
 */
export type RiskCategory = "destroy" | "secrets" | "ship" | "outside" | "money" | "unknown-code" | "guardrails";
export interface Risk { risky: boolean; category?: RiskCategory }

/** Clauses that start by reading, asking, explaining, drafting or building; scary words after them are about, not doing. */
const READ_ONLY_LEAD = /^\s*(?:(?:please|can you|could you|now|then)\s+)*(?:explain|why|how|what|who|where|when|which|summari[sz]e|review|find|list|look up|compare|read|check|count|describe|draft|write|add (?:a |some )?tests?|generate|refactor|update the docs|update the changelog|preview|rename|give me a (?:summary|list|count)|open (?:the )?(?:local|dev|localhost|browser|page|file|folder|project|docs?)|fix|look at|save the draft|turn the|sort the|ask @|tell @|show me the (?:git )?log|run the (?:unit )?tests?|run the linter|build|kick off the tests?|make the|migrate the schema on my local)\b/i;

/** Said anywhere: the goal itself promises not to do the risky thing. */
const PROMISES_NOT_TO = /\b(?:do not|don't|dont|without|never)\s+(?:send|deploy|deploying|run|running|publish|publishing|push|pushing|merge|merging|actually)\b|\bjust read\b|\bin a local file\b|\bsave (?:it )?to \S+\.md\b|\bleave it in \S+\.md\b|\b(?:in|to) (?:notes|docs|drafts?)[\\/]\S+\.md\b/i;

/** Deleting these is routine, not destruction. */
const DISPOSABLE = /\b(?:temp|tmp|scratch|cache|\.next|console\.log|debug lines?|unused imports?|that you (?:just )?(?:created|made|added))\b/i;

const has = (re: RegExp, text: string) => re.test(text);

// A verb and, within a short span, the thing it acts on.
const near = (verbs: string, objects: string, span = 60) => new RegExp(`\\b(?:${verbs})\\b[^.\\n]{0,${span}}(?<![A-Za-z0-9_])(?:${objects})`, "i");

const DESTROY = [
  near(
    "delete|remove|wipe|erase|destroy|drop|purge|truncate|nuke|obliterate|trash|junk|zap|blow away|get rid of|clear out|throw away|kill|shred",
    "files?|folders?|director(?:y|ies)|databases?|tables?|data|branch(?:es)?|repos?|repositories|history|accounts?|buckets?|snapshots|tests?|logs|build|dist|node_modules|volumes?|backups?|uploads?|everything|clusters?|instances?|servers?|deployments?|records?|rows|users|projects?|workspaces?|containers?|images|commits|stash|saved",
  ),
  /\brm\s+-\w*[rf]/i, /\boverwrite\b[^.\n]{0,30}\b(?:remote|origin|main|master|history)\b/i, /\b(?:undo|revert|rewind)\b[^.\n]{0,40}\bcommits?\b[^.\n]{0,40}\b(?:remote|origin|push)/i, /\breset\s+--hard\b/i, /\bforce[- ]push\b|\bpush\b[^.\n]{0,30}--force|\bgit\s+clean\s+-\w*f/i,
  /\bdocker\s+(?:system|volume)\s+prune\b|\bformat\s+(?:the\s+)?(?:disk|drive|c:)|\bdel\s+\/[sfq]/i,
];

// Disclosing or changing a secret; "read" alone is not disclosure.
const SECRET_OBJECT = "\\.env\\b|env(?:ironment)? files?|dotenv|env(?:ironment)? var(?:iable)?s?|(?:api|access|secret|auth|anthropic|openai|stripe|aws|github|supabase|vercel|ssh)[ _-]?keys?|keys? (?:from|in|for)|secrets?|private keys?|id_rsa|id_ed25519|\\.ssh|tokens?|passwords?|passphrases?|credentials?|service[ _-]?role|cookies?";
const SECRETS = [
  near("print|show|paste|copy|share|send|commit|put|reveal|dump|display|expose|cat|echo|log|output|rotate|revoke|regenerate|export|upload|give me|hand (?:me|over)|grab|fetch|get me|retrieve|leak|post|email|gist|pipe", SECRET_OBJECT),
  /\b[A-Z][A-Z0-9]*_(?:TOKEN|KEY|SECRET|PASSWORD)\b/, /\bprintenv\b|\bprint (?:the )?env(?:ironment)?\b|\bgit\s+add\b[^.\n]{0,20}\.env\b/i,
];

const SHIP = [
  /\bgit\s+push\b/i,
  /\bpush\b[^.\n]{0,40}\b(?:branch|branches|commits?|main|master|origin|fork|remote|changes|tags?)\b/i,
  /\bmerge\b[^.\n]{0,40}\b(?:into|to|onto)\b[^.\n]{0,15}\b(?:main|master|prod|production|develop|release)\b/i,
  /\bmerge\b[^.\n]{0,20}\b(?:branch|pull request|pr)\b/i,
  /\b(?:deploy|publish|release|ship|promote|roll ?out|go live|push live|make it live|put it live)\b/i,
  /\bget (?:this|it|that|the \w+) out\b[^.\n]{0,30}\b(?:to|in)\b[^.\n]{0,10}\b(?:prod|production|users|customers|the world)\b/i, /\bland\b[^.\n]{0,40}\b(?:on|in|into|to)\b[^.\n]{0,10}\b(?:main|master|prod|production)\b/i,
  /\bopen (?:a |the )?(?:pr|pull request|merge request)\b[^.\n]{0,40}\b(?:upstream|origin|main|against)\b/i,
  /\bnpm\s+publish\b|\bvercel\b[^.\n]{0,20}--prod\b|\btag\b[^.\n]{0,12}\bv?\d+\.\d+/i,
];

// Sending to people or public places. Messages between agents, and to the user, are never in scope.
const OUTSIDE = [
  near(
    "send|email|e-mail|post|reply|message|dm|tweet|comment|announce|respond|tell|notify|inform|let|ping|write to|write back|broadcast|publish|blast",
    "customers?|clients?|team|everyone|founders?|vendors?|issues?|pull requests?|slack|discord|twitter|linkedin|mailing|public|announcement|list|x\\b|prospects?|leads?|investors?|press|subscribers?|followers?|users|thread|channel|stakeholders?|community|newsletter|partners?|reddit|hacker news|the world|them know|reporter|maintainers?|waitlist|people on",
    70,
  ),
  /\btweet\b|\bretweet\b|\bsend (?:an? |the |out )?(?:e-?mail|dm|newsletter|invite|invitation|slack message|text message|sms)\b/i,
  /\b(?:cold )?emails? (?:the|to|all|our)\b/i,
];

const MONEY = [
  near(
    "charge|refund|bill|invoice|pay|purchase|buy|subscribe|upgrade|downgrade|renew|top up|transfer|wire|donate|put|order|book|settle|start|raise|increase|bump|lift|add",
    "customers?|cards?|payments?|plans?|tiers?|domains?|subscriptions?|credits?|annual|monthly|funds?|money|dollars?|usd|\\$\\d|accounts?|bills?|balance|fees?|licen[cs]es?|seats?|hosting|spend(?:ing)?|budget|limit|company card|payment method|pro trial|invoice|aws|azure|gcp",
  ),
  /\bpaid (?:plan|tier|trial|pro|autoscaling|add-?on|feature)s?\b|\benable billing\b|\bturn on (?:paid|billing)\b|\bstripe\b[^.\n]{0,30}\b(?:charge|refund|payout)/i,
];

const UNKNOWN_CODE = [
  /\|\s*(?:sh|bash|zsh|iex|python\d?)\b/i, /\biwr\b|\binvoke-webrequest\b[^.\n]{0,60}\biex\b/i,
  /\bpipe\b[^.\n]{0,60}\b(?:bash|sh|zsh|powershell|iex|python\d?)\b/i, /\brun\b[^.\n]{0,30}\bas (?:admin|administrator|root)\b/i,
  near("download|install|run|execute|paste|eval", "random|unknown|unpublished|gist|from the internet|from that link|that link|base64|someone sent|untrusted|postinstall", 70),
  near("fetch|download|grab|curl|wget|install|run|execute|open|launch", "installer|\\.exe|\\.msi|\\.bat|\\.ps1|attachment|paste site|pastebin|discord link|telegram|from (?:a|the) (?:web|net|internet)|link someone|unsigned", 70),
  /\bsudo\b[^.\n]{0,40}\b(?:sh|bash|script|install)\b|\bwith sudo\b/i,
];

const GUARDRAILS = [
  near(
    "edit|change|rewrite|modify|update|remove|delete|disable|turn off|bypass|skip|weaken|loosen|comment out|relax|neutrali[sz]e|silence|allowlist|whitelist|grant|elevate|add a rule to|stop requiring|make .{0,20} optional|no longer require",
    "claude\\.md|agents\\.md|\\.codex[\\\\/]|config\\.toml|hooks?(?:\\.json)?|\\.claude[\\\\/]|settings\\.json|settings\\.local|sandbox|permissions?|permission mode|full access|approvals?|approval (?:check|step|gate)|guardrails?|github actions|workflows?|\\.github|required checks?|branch protection|pre-?commit|husky|codeowners|firewall|cors|two-factor|2fa|mfa|security scan|auth(?:entication|orization)? (?:check|middleware|guard)|auth check|failing tests? in ci|tests? in ci|optional in the pipeline|\\bci\\b",
    70,
  ),
  /\bturn off\b[^.\n]{0,30}\b(?:sandbox|approvals?|permission|guardrails?)\b/i,
];

const CATEGORIES: Array<[RiskCategory, RegExp[]]> = [
  ["destroy", DESTROY], ["secrets", SECRETS], ["ship", SHIP], ["outside", OUTSIDE], ["money", MONEY], ["unknown-code", UNKNOWN_CODE], ["guardrails", GUARDRAILS],
];

/** Sharing a key or private file is risky however the sentence starts. */
const DISCLOSURE = /\b(?:paste|share|send|copy|print|dump|reveal|commit|upload|show me|give me|hand (?:me|over)|leak|post|email|gist)\b/i;
const SECRET_NOUN = new RegExp(SECRET_OBJECT, "i");

/** "Review it and push to main" is two requests; a read-only first half must not hide the second. */
const CLAUSE_SPLIT = /\s*(?:;|\.\s|,\s*(?:and\s+)?(?:then\s+)?|\b(?:and then|and also|and|then|after that|afterwards)\b)\s*/i;

function classifyClause(text: string): Risk {
  if (has(READ_ONLY_LEAD, text)) return { risky: false };
  for (const [category, patterns] of CATEGORIES) {
    if (category === "destroy" && has(DISPOSABLE, text)) continue;
    if (patterns.some((re) => has(re, text))) return { risky: true, category };
  }
  return { risky: false };
}

export function classifyRisk(goal: string): Risk {
  const text = goal.replace(/\s+/g, " ").trim();
  if (has(PROMISES_NOT_TO, text)) return { risky: false };
  if (has(DISCLOSURE, text) && has(SECRET_NOUN, text)) return { risky: true, category: "secrets" };
  const whole = classifyClause(text);
  if (whole.risky) return whole;
  for (const clause of text.split(CLAUSE_SPLIT)) {
    if (clause.length < 6) continue;
    const r = classifyClause(clause);
    if (r.risky) return r;
  }
  return { risky: false };
}
