/**
 * Create the team every customer project goes under, and store its id.
 *
 * `project` provisioning gives each customer a LangWatch project of their
 * own, and a project belongs to a team. That team is one stable thing for the
 * whole platform rather than something a signup decides, so it is created
 * once, here:
 *
 *   pnpm setup:team
 *
 * Re-running is safe: a team already named this one is reused rather than
 * duplicated, so this is also how you recover a lost LANGWATCH_TEAM_ID. The
 * id is written into `.env` as LANGWATCH_TEAM_ID, and printed so you can
 * store it wherever your deployment keeps configuration.
 */
import "../app/src/env.js";
import { teams } from "../app/src/langwatch.js";
import { writeEnv } from "./env-file.js";

const TEAM_NAME = "ACME Agents customers";

if (!process.env.LANGWATCH_API_KEY) {
  console.error("LANGWATCH_API_KEY is not set. Fill in .env first.");
  process.exit(1);
}

// The name is the identity: an org has few teams, and matching on it is what
// makes a second run reuse the first run's team instead of stacking another.
const existing = (await teams.list({ limit: 100 })).data.find(
  (team) => team.name === TEAM_NAME,
);
const team = existing ?? (await teams.create({ name: TEAM_NAME }));

writeEnv("LANGWATCH_TEAM_ID", team.id);

console.log(
  `${existing ? "Reused" : "Created"} the team "${team.name}"\n` +
    `  team:  ${team.id}\n` +
    "  stored in .env as LANGWATCH_TEAM_ID\n\n" +
    "Set LANGWATCH_PROVISION_MODE=project and restart the app to provision" +
    " a project per customer.",
);
