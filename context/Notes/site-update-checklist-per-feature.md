# Updating the website after a feature ships

1. Read the feature's spec in `context/spec/<NNN-name>/` (functional-spec.md, technical-considerations.md) and the updated `context/product/product-definition.md` and `architecture.md`. The site must describe what was built, not what was planned.
2. Work in the arc-sample repo (see website-repo-and-workflow). Start a worker with arc-sample as the project and harness as read-only reference.
3. Update `index.html`, `seo/content.ts`, and refresh `seo/docs/*.md` from the harness product docs.
4. Run `pnpm build` and `scripts/seo-check.mjs`.
5. Merging to the session branch is not a release: push and deploy to tests.myedgenet.com separately.
6. Copy rules: HUD tone, no emojis, no AI filler.
