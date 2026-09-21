# M9R public website implementation

## Scope

Original CRT/sky/clay-head artwork and narrative inspired by The InnerWebs. No third-party source, logo, or artwork copied. Shared public shell, homepage guide, How It Works, Docs/Get Started, FAQ, Pricing, Open Core, and browser-storage notice. Existing application and legal routes remain intact.

## Source of truth and intentional corrections

- Public commands live in `src/lib/marketing-content.ts`; homepage, how-to, and docs render one Guide.
- `cli/package.json` exposes `m9r-cli`, not `m9r`.
- `init` connects a hosted workspace. `setup` is the separate native local path and currently installs Claude Code hooks and CLAUDE.md instructions only.
- Native preview commands are implemented in the working checkout, but npm release availability has not been verified. They remain labeled preview.
- A queued task is not proof of delivered or completed work. No live metrics or fake connected statuses appear.
- The hero screen has an optional React slot; no hidden activation or final surprise has been shipped.

## Authentication boundary

Existing Supabase password/OAuth authentication, verification, redirects, and invitation handling are preserved. Get started opens signup directly. An email row in D1 is not authentication and must not grant access. No D1 migration, verification bypass, Turnstile integration, email-service change, or production configuration change was made. No Resend dependency was added.

No waitlist is introduced. If password signup still requires email confirmation in production, that is existing provider configuration; do not claim that requirement has been removed. A real signup/invite acceptance smoke test requires an authorized test account and production/provider configuration review.

## Launch items still requiring owner decisions

- Existing Privacy Policy explicitly lacks the legal operator and mailing address. Existing policies were not represented as lawyer-reviewed or complete.
- Early Access Agreement, subprocessors, status, and changelog pages are not fabricated. Add only with approved terms and actual service facts. Open signup does not establish a separate early-access contract.
- Social links use existing GitHub and X links only. Team access is a contact email, not a paid checkout or automatic feature grant.
- The native CLI implementation and release status must be rechecked before removing preview labels.
- Preserve the existing auth service until a separately scoped, secure identity migration is approved.

## Local verification

Use `npm run dev -- --webpack --port 3005`; the default Next 16 dev command conflicts with the repository's existing webpack customization.

Run `node --import ./scripts/register-alias.mjs --test scripts/marketing-content.test.ts` for content/CLI contract checks. These checks are not end-to-end provider installation or authentication tests.
