// Single source of truth for everything the SEO build step generates: head
// tags, JSON-LD, the visible FAQ, the noscript summary, llms.txt, llms-full.txt
// and the web manifest. Every fact here comes from the vendored product docs in
// seo/docs/ (product-definition.md and architecture.md); `source` names the
// section. Items the docs mark as an assumption are not used as facts.
// One exception: the A2UI panel preview is a spike that is not in the product
// docs yet, so its facts come from the app's source and `source` names the files.

export const PLACEHOLDER_SITE_URL = 'https://arc.example.com';

export const site = {
  name: 'Arc',
  title: 'Arc - local-first macOS agent harness for Claude Code and Codex',
  description:
    'Arc is a local-first macOS agent harness that points your Claude Code and Codex subscriptions at a whole group of repos. Lasting knowledge, no API keys.',
  /** One-paragraph summary used for llms.txt, the noscript block and JSON-LD. */
  summary:
    'Arc is a personal, local-first macOS desktop app that points the Claude Code and Codex subscriptions a developer already pays for at a whole group of related repositories, with lasting knowledge (notes, docs, schemas, playbooks, links) attached to the group. A brain agent plans the work, worker agents fan out across the repos in their own git worktrees, and the result lands on one session branch for the developer to review.',
  /** Headline drawn on the Open Graph image (scripts/build-images.mjs); same as the page h1. */
  ogHeadline: 'One agent harness across your whole group of repos.',
  ogImageAlt:
    'Arc: a cyan ring logo and a brain-and-workers branch diagram on a navy HUD grid, with the line "One agent harness across your whole group of repos."',
  themeColor: '#03080F',
  locale: 'en_US',
  language: 'en',
  /** Product definition status, shown so agents do not mistake it for a shipped release. */
  status: 'Product definition v1.0, status: proposed. Personal build, signed ad hoc, not yet notarized.',
} as const;

export interface Faq {
  q: string;
  a: string;
  source: string;
}

export const faqs: Faq[] = [
  {
    q: 'Does Arc need API keys?',
    a: 'No. Arc runs on the Claude and Codex subscriptions you already have by driving the locally installed Claude Code and Codex CLIs. It uses no direct API keys and makes no Anthropic or OpenAI SDK calls, so there is no separate API billing.',
    source: 'architecture.md 4. External Services & APIs; product-definition.md 1.4',
  },
  {
    q: 'Is Arc local-first?',
    a: 'Yes. Everything runs on your Mac. There is no backend or cloud service, no accounts, sharing or sync, and the app makes no network calls of its own. Crash reports are written locally only, with no remote telemetry.',
    source: 'architecture.md 3. Hosting, 4. Web content for Links, 6. Crash handling; product-definition.md 1.2',
  },
  {
    q: 'Which AI providers does Arc support?',
    a: 'Claude Code, using your Claude subscription, and the Codex CLI, using your ChatGPT/Codex subscription. You can mix both in one session. The brain picks a provider and model per worker, and you can override it for the whole session or for any single worker.',
    source: 'architecture.md 1. Agent runtime adapters, 4. AI providers; product-definition.md 2.1',
  },
  {
    q: 'What does Arc never do?',
    a: 'Arc never handles your credentials (the CLIs run their own login), never pushes branches or merges the session branch into dev (that stays with you), never discards uncommitted changes (it asks you to stash, commit, carry them over or cancel), never connects to live databases, and never makes network calls of its own.',
    source: 'architecture.md 1. Agent runtime adapters, 2. Git state, 4. External Services; product-definition.md 3.2',
  },
  {
    q: 'What do I need to run Arc?',
    a: 'A Mac (Arc is a single-user macOS app, Apple Silicon first) and a Claude or Codex subscription with the matching CLI installed on your PATH and logged in. Arc checks both on first run and tells you which login command to run. Windows and Linux are out of scope.',
    source: 'architecture.md 1. Agent runtime adapters, 3. Packaging; product-definition.md 3.1, 3.2',
  },
  {
    q: 'How do several agents change the same repo without clashing?',
    a: 'Starting a session creates a session branch in each repo. Every worker gets its own git worktree at the tip of that branch. The brain merges finished work back one merge at a time per repo, and a short-lived resolver worker handles conflicts; it escalates to you only when it is not confident. The brain never edits code itself.',
    source: 'architecture.md 2. Git state; product-definition.md 2.1',
  },
  {
    q: 'Does Arc read my production database?',
    a: 'No. Database schemas are provided as static docs, such as a schema-only dump with structure and no data. Connecting to live databases or querying real data is out of scope.',
    source: 'product-definition.md 2.1 Docs, 3.2',
  },
  {
    q: 'What happens when an agent needs permission or has a question?',
    a: 'The worker pauses and asks the brain first. The brain answers from the plan, the group\'s knowledge or other workers\' results, and escalates anything it cannot or may not decide to you as an alert with Approve, Deny or an answer box, plus a macOS notification when Arc is in the background. Pending requests survive closing and resuming the session.',
    source: 'product-definition.md 2.1 Approvals and questions; architecture.md 1. Approval and question escalation',
  },
  {
    q: 'How does Arc\'s knowledge grow from one session to the next?',
    a: 'When the brain finishes a request it can suggest things worth keeping through its suggest_knowledge_update tool: a new note, or a change to an existing one, in Notes, Docs, Playbooks or a custom section, never in Projects or Links. It makes up to 5 suggestions per request, none while workers are still running, and never repeats one or offers one you discarded. You can also ask it for suggestions at any time.',
    source: 'product-definition.md 2.1 Learning loop; architecture.md 1. Learning loop (spec 011)',
  },
  {
    q: 'Can the brain change my notes and docs on its own?',
    a: 'No. Nothing is written until you accept. Waiting suggestions show as a Suggestions chip with the count in the session header, and the brain\'s answer ends with a line that opens the same Knowledge suggestions dialog. Each card shows what the brain learned, where it would go, and the new note\'s text or the lines the change adds and removes. You Accept, Edit or Discard each card, or use Accept all and Discard all. If a note changed after the suggestion was made, Arc says so and writes nothing. A "Suggest knowledge updates" switch in Settings, on by default, stops the brain suggesting on its own; it still answers when asked.',
    source: 'product-definition.md 2.1 Learning loop; architecture.md 1. Learning loop (spec 011)',
  },
  {
    q: 'Can the brain show charts, tables or forms in the conversation?',
    a: 'Yes, as a preview. Through its show_surface tool the brain can show an interactive panel in the conversation: text, inputs, buttons, KPI tiles, tables, and bar and line charts. It writes the panel in A2UI Express, a compact text form of the A2UI format, and Arc compiles it with the official A2UI agent SDK and draws it in its own HUD style from Arc\'s component catalog. The tool does not wait: when you press a button, the brain gets a message that starts with "[Surface action]" carrying the event name and its context values as you left them. This is a spike, so the components, the format and the event shape may change or be removed.',
    source: 'Arc source (A2UI spike, not yet in the product docs): src/main/surface/arc-catalog.ts, src/main/surface/express.ts, src/main/bridge/tools/show-surface.ts, src/renderer/src/lib/components/sessions/SurfaceView.svelte and SurfaceChart.svelte',
  },
];

/** Feature list for the SoftwareApplication JSON-LD. */
export const features: string[] = [
  'Groups of local repositories with lasting knowledge: Projects, Notes, Docs, Prompts and Playbooks, Links and custom sections',
  'Brain agent that plans and spawns worker agents, one per sub-task',
  'Plan-first or autonomous spawn mode with a worker cap',
  'A session branch per repo and one git worktree per worker, merged back by the brain',
  'Worker questions and permission requests routed to the brain and escalated to you when needed',
  'Mix Claude Code and Codex in one session, with per-session and per-worker model override',
  'Subscription usage and rate-limit display that guides model choice',
  'Saved, resumable sessions',
  'Learning loop: the brain suggests new notes or changes to existing ones, up to 5 per request, and you accept, edit or discard each one',
  'A Suggestions chip in the session header and a Knowledge suggestions dialog that shows each new note or the lines a change adds and removes',
  'Chat first, with each worker\'s terminal available on demand',
  'Local MCP bridge on 127.0.0.1 with a per-session token',
  'Preview (spike): interactive panels in the conversation, written by the brain in A2UI Express and drawn in Arc\'s HUD style from Arc\'s component catalog: text, inputs, buttons, KPI tiles, tables, bar and line charts',
  'Preview (spike): a button press in a panel returns a "[Surface action]" event to the brain with the event name and its context values',
];

export const requirements =
  'macOS (Apple Silicon first). Claude Code and/or Codex CLI installed on the PATH and logged in to a Claude or ChatGPT/Codex subscription.';

/**
 * Sections of the vendored docs copied into llms-full.txt, by heading. The
 * product definition is included whole; from the architecture only the parts
 * a reader of the site would ask about.
 */
export const fullDocs = [
  { file: 'product-definition.md', title: 'Product definition', headings: null },
  {
    file: 'architecture.md',
    title: 'Architecture excerpts',
    headings: ['3. Infrastructure & Deployment', '4. External Services & APIs', '5. Security', '6. Observability & Monitoring'],
  },
] as const;
