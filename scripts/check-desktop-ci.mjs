const repository = process.env.GITHUB_REPOSITORY;
const commitSha = process.env.GITHUB_SHA;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!repository || !commitSha || !token) {
  throw new Error('GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_TOKEN are required');
}

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
};

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const query = new URLSearchParams({
  head_sha: commitSha,
  event: 'push',
  per_page: '100',
});
const { workflow_runs: workflowRuns } = await github(
  `actions/workflows/ci.yml/runs?${query.toString()}`,
);
const run = workflowRuns
  .filter((candidate) => candidate.head_branch === 'feat/tauri-desktop')
  .sort((left, right) => new Date(left.created_at) - new Date(right.created_at))
  .at(-1);

if (!run) {
  throw new Error(`No push-triggered CI run found for feat/tauri-desktop at ${commitSha}`);
}
if (run.status !== 'completed' || run.conclusion !== 'success') {
  throw new Error(
    `CI run ${run.html_url} is ${run.status} with conclusion ${run.conclusion || 'none'}`,
  );
}

const { jobs } = await github(`actions/runs/${run.id}/jobs?per_page=100`);
const requiredJobs = [
  'Lint, Typecheck & Unit Tests',
  'Render Service (typecheck + tests)',
  'E2E Tests',
  'Desktop Build & Rust Tests',
];
for (const requiredJob of requiredJobs) {
  const job = jobs.find((candidate) => candidate.name === requiredJob);
  if (!job) {
    throw new Error(`CI run ${run.html_url} is missing required job: ${requiredJob}`);
  }
  if (job.status !== 'completed' || job.conclusion !== 'success') {
    throw new Error(
      `Required CI job ${requiredJob} is ${job.status} with conclusion ${job.conclusion || 'none'}`,
    );
  }
}

console.log(`[check-desktop-ci] complete CI succeeded for ${commitSha}: ${run.html_url}`);
