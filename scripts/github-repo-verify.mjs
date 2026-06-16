import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  return {
    apply: flags.has("--apply"),
    prTest: flags.has("--pr-test"),
    json: flags.has("--json"),
  };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function parseRepo(value) {
  const v = (value || "").trim();
  const m = v.match(/^([^/]+)\/([^/]+)$/);
  if (!m) throw new Error(`Invalid REPO value: ${value}`);
  return { owner: m[1], repo: m[2] };
}

function uniq(list) {
  const s = new Set();
  for (const v of list) if (v) s.add(v);
  return [...s];
}

async function ghApi({ token, method, url, body, accept }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    Accept: accept || "application/vnd.github+json",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  const isJson = contentType.includes("application/json") || text.startsWith("{") || text.startsWith("[");
  const parsed = isJson ? JSON.parse(text) : text;
  if (!res.ok) {
    const msg = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    const err = new Error(`${method} ${url} -> ${res.status} ${res.statusText}: ${msg}`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  return parsed;
}

async function bestEffort(promise, onError) {
  try {
    return await promise;
  } catch (e) {
    if (onError) onError(e);
    return { ok: false, error: String(e?.message || e) };
  }
}

function runGit(args, { cwd, extraEnv } = {}) {
  const env = { ...process.env, ...(extraEnv || {}) };
  return execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

async function main() {
  const args = parseArgs(process.argv);
  const token = requireEnv("GH_TOKEN");
  const repoValue = process.env.REPO || "barry2810/Ahlert-ERP";
  const { owner, repo } = parseRepo(repoValue);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

  const result = {
    ok: true,
    repo: { owner, repo },
    auth: null,
    repoInfo: null,
    settings: { applied: false, errors: [] },
    branchProtection: { applied: false, errors: [], requiredCheckContexts: [] },
    prWorkflow: { executed: false, errors: [], prUrl: null, branch: null },
  };

  const user = await ghApi({ token, method: "GET", url: "https://api.github.com/user" });
  result.auth = { login: user?.login, id: user?.id };

  const repoInfo = await ghApi({ token, method: "GET", url: apiBase });
  result.repoInfo = {
    name: repoInfo?.name,
    full_name: repoInfo?.full_name,
    private: repoInfo?.private,
    default_branch: repoInfo?.default_branch,
    url: repoInfo?.html_url,
  };

  if (args.apply) {
    const settingsPatch = {
      delete_branch_on_merge: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
      allow_merge_commit: false,
      allow_auto_merge: true,
      web_commit_signoff_required: false,
    };

    await bestEffort(
      ghApi({ token, method: "PATCH", url: apiBase, body: settingsPatch }),
      (e) => result.settings.errors.push(String(e?.message || e)),
    );
    result.settings.applied = result.settings.errors.length === 0;

    const mainRef = result.repoInfo.default_branch || "main";
    const commit = await ghApi({ token, method: "GET", url: `${apiBase}/commits/${encodeURIComponent(mainRef)}` });
    const sha = commit?.sha;

    const checkRuns = await bestEffort(
      ghApi({ token, method: "GET", url: `${apiBase}/commits/${encodeURIComponent(sha)}/check-runs` }),
      (e) => result.branchProtection.errors.push(String(e?.message || e)),
    );

    const contexts = Array.isArray(checkRuns?.check_runs)
      ? uniq(checkRuns.check_runs.map((r) => r?.name)).filter((n) => typeof n === "string" && n.length > 0)
      : [];
    result.branchProtection.requiredCheckContexts = contexts;

    const protectionBody = {
      required_status_checks: contexts.length > 0 ? { strict: true, contexts } : null,
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: true,
      },
      restrictions: null,
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      required_conversation_resolution: true,
    };

    await bestEffort(
      ghApi({ token, method: "PUT", url: `${apiBase}/branches/${encodeURIComponent(mainRef)}/protection`, body: protectionBody }),
      (e) => result.branchProtection.errors.push(String(e?.message || e)),
    );
    result.branchProtection.applied = result.branchProtection.errors.length === 0;

    await bestEffort(
      ghApi({
        token,
        method: "PUT",
        url: `${apiBase}/vulnerability-alerts`,
        accept: "application/vnd.github+json",
      }),
      (e) => result.settings.errors.push(`vulnerability-alerts: ${String(e?.message || e)}`),
    );

    await bestEffort(
      ghApi({
        token,
        method: "PUT",
        url: `${apiBase}/automated-security-fixes`,
        accept: "application/vnd.github+json",
      }),
      (e) => result.settings.errors.push(`automated-security-fixes: ${String(e?.message || e)}`),
    );
  }

  if (args.prTest) {
    const sshConfig = process.env.GIT_SSH_CONFIG || "/opt/ahlert-erp/.local/ssh/config";
    const gitSshCommand = `ssh -o BatchMode=yes -F ${sshConfig}`;

    const tmp = mkdtempSync(path.join(os.tmpdir(), "ahlert-erp-pr-test-"));
    try {
      const remote = `git@github.com:${owner}/${repo}.git`;
      runGit(["clone", remote, tmp], { extraEnv: { GIT_SSH_COMMAND: gitSshCommand } });

      const branch = `test/gh-pr-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`;
      result.prWorkflow.branch = branch;

      runGit(["config", "user.name", "Ahlert ERP Local Setup"], { cwd: tmp });
      runGit(["config", "user.email", "noreply@ahlert.local"], { cwd: tmp });
      runGit(["checkout", "-b", branch], { cwd: tmp });

      runGit(
        [
          "commit",
          "--allow-empty",
          "-m",
          `test: pr workflow verification (${new Date().toISOString()})`,
        ],
        { cwd: tmp },
      );

      runGit(["push", "-u", "origin", branch], { cwd: tmp, extraEnv: { GIT_SSH_COMMAND: gitSshCommand } });

      const pr = await ghApi({
        token,
        method: "POST",
        url: `${apiBase}/pulls`,
        body: {
          title: `test: PR workflow verification (${new Date().toISOString()})`,
          head: branch,
          base: result.repoInfo.default_branch || "main",
          body: "Automatisch erstellter PR zur Verifizierung von gh/PR-Workflow und Branch-Schutzregeln.",
          draft: true,
        },
      });

      result.prWorkflow.prUrl = pr?.html_url || null;

      await ghApi({
        token,
        method: "PATCH",
        url: `${apiBase}/pulls/${pr.number}`,
        body: { state: "closed" },
      });

      await ghApi({
        token,
        method: "DELETE",
        url: `${apiBase}/git/refs/heads/${encodeURIComponent(branch)}`,
      });

      result.prWorkflow.executed = true;
    } catch (e) {
      result.prWorkflow.errors.push(String(e?.message || e));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`repo: ${owner}/${repo}`);
  lines.push(`auth: ${result.auth?.login || "unknown"}`);
  lines.push(`default_branch: ${result.repoInfo?.default_branch || "unknown"}`);
  lines.push(`repo_url: ${result.repoInfo?.url || "unknown"}`);
  if (args.apply) {
    lines.push(`settings_applied: ${result.settings.applied}`);
    lines.push(`branch_protection_applied: ${result.branchProtection.applied}`);
    if (result.branchProtection.requiredCheckContexts.length > 0) lines.push(`required_checks: ${result.branchProtection.requiredCheckContexts.join(", ")}`);
    if (result.settings.errors.length > 0) lines.push(`settings_errors: ${result.settings.errors.join(" | ")}`);
    if (result.branchProtection.errors.length > 0) lines.push(`branch_protection_errors: ${result.branchProtection.errors.join(" | ")}`);
  }
  if (args.prTest) {
    lines.push(`pr_test_executed: ${result.prWorkflow.executed}`);
    if (result.prWorkflow.prUrl) lines.push(`pr_url: ${result.prWorkflow.prUrl}`);
    if (result.prWorkflow.errors.length > 0) lines.push(`pr_test_errors: ${result.prWorkflow.errors.join(" | ")}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((e) => {
  process.stderr.write(`${String(e?.message || e)}\n`);
  process.exitCode = 1;
});

