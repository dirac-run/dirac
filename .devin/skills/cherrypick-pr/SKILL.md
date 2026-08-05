---
name: cherrypick-pr
description: >
  Open a clean, single-commit PR from an existing commit on a feature branch.
  Cherry-pick the commit onto a new branch based on origin/master, push it to
  the fork, and create the PR with gh. Assumes author is Alexandros Salapatas
  with an empty email.
---

# Cherry-pick PR

Use this workflow when the user wants to move a **single, isolated code commit** from a feature branch into a PR against `master`.

## When to use

- User says things like "move this commit to master and open a PR", "open a PR for this fix", "cherry-pick this to master".
- The target branch (e.g. `dev-to-master`) may contain other commits (dot commits, docs, deletions) that must **not** be included in the PR.
- The desired PR must contain exactly one commit with author `Alexandros Salapatas <>`.

## Workflow

1. **Identify the target commit.**
   - It should be the one containing the code/test changes.
   - Exclude dot commits, docs, and deletion commits.

2. **Verify the commit contents and author.**

   ```sh
   git show --stat --format='Author: %an <%ae>%n%nFiles changed:' <commit>
   ```

3. **Create a clean PR branch from the latest master.**

   ```sh
   git fetch origin
   git checkout -b pr/<short-description> origin/master
   ```

4. **Cherry-pick the single commit.**

   ```sh
   git cherry-pick <commit>
   ```

   If there are conflicts:

   ```sh
   # resolve conflicts, then:
   git add -A
   git cherry-pick --continue
   ```

5. **Verify the resulting commit author and files.**

   ```sh
   git log -1 --format='Author: %an <%ae>%nSubject: %s'
   git diff origin/master --stat
   ```

   If the author is not `Alexandros Salapatas <>`, amend it:

   ```sh
   git commit --amend --author='Alexandros Salapatas <>' --no-edit
   ```

6. **Push the new branch to the fork.**

   ```sh
   git push -u fork pr/<short-description>
   ```

7. **Open the PR against the upstream repository.**

   ```sh
   gh pr create --repo dirac-run/dirac \
     --base master \
     --head alexdim:pr/<short-description> \
     --fill
   ```

   `--fill` reuses the commit subject and body as the PR title and description.

8. **Return to the original feature branch.**

   ```sh
   git checkout <original-branch>
   ```

## Example

```sh
git fetch origin
git checkout -b pr/surface-rule-load-failures origin/master
git cherry-pick 82049da
git log -1 --format='Author: %an <%ae>%nSubject: %s'
git push -u fork pr/surface-rule-load-failures
gh pr create --repo dirac-run/dirac --base master --head alexdim:pr/surface-rule-load-failures --fill
git checkout dev-to-master
```

## Assumptions and replacements

- Upstream remote is `origin`, canonical repo is `dirac-run/dirac`.
- Fork remote is `fork` and the GitHub owner is `alexdim`.
- For other repositories, replace `--repo`, `--head <owner>:branch`, and `fork` remote accordingly.
- If the commit author should be different, change the `--author` string or the author config.

## Safety checks

- Confirm the diff only touches code and tests: `git diff origin/master --stat`.
- Confirm the author is `Alexandros Salapatas <>` before pushing.
