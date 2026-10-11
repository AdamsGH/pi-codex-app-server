# Model projects after Codex project roots

Keep a persistent Codex-compatible project catalog and associate discovered Pi sessions by their Git worktree root. Nested working directories share one project, separate worktrees remain distinct roots, and explicit app-server projects may contain multiple roots.

Do not automatically create a project for every non-Git working directory. Keep those sessions in the Pi section until explicitly assigned. This replaces the previous cwd fallback, which would create projects for home directories and temporary test sessions. A deleted automatic project stays deleted; explicit assignment and unassignment survive catalog refreshes.
