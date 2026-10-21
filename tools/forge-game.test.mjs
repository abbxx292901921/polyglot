/* Forge minigame authoring test: checks the agent can actually propose a
   working game. The guide, the skeleton example, the action parser and the
   validator all have to agree, or the agent will keep proposing games the
   host rejects.
   Run with:  node tools/forge-game.test.mjs */

import {
  SUPERVISOR_ACTIONS,
  READ_ACTIONS,
  WRITE_ACTIONS,
  parseSupervisorReply,
  validateAction,
  describeAction,
  buildSupervisorPrompt
} from "../js/supervisor.js";
import {
  GAME_AUTHORING_GUIDE,
  GAME_SKELETON_HTML,
  validateMinigameHtml,
  slugKey
} from "../js/minigames.js";

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (extra ? " :: " + extra : ""));
}
function eq(name, got, want) {
  ok(name, got === want, "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}

// ---------- protocol surface ----------

ok("list_minigames is a read", READ_ACTIONS.includes("list_minigames"));
ok("get_minigame is a read", READ_ACTIONS.includes("get_minigame"));
ok("create_minigame is a write", WRITE_ACTIONS.includes("create_minigame"));
ok("delete_minigame is a write", WRITE_ACTIONS.includes("delete_minigame"));
ok("create_minigame is a known action", SUPERVISOR_ACTIONS.includes("create_minigame"));

// ---------- the system prompt ----------

const prompt = buildSupervisorPrompt({
  characters: [{ id: 1, name: "Rin" }],
  chats: [{ id: 7, character_id: 1, title: "Rin" }],
  personas: [{ id: 2, name: "You" }],
  presets: [{ id: 3, name: "Default", model: "m" }],
  providers: [{ id: 4, name: "Default" }],
  lorebooks: [],
  minigames: [{ key: "dice-rogue", name: "Dice Rogue", desc: "A dice dungeon", author: "forge" }]
});

ok("prompt names the read", prompt.includes("list_minigames"));
ok("prompt names the write", prompt.includes("create_minigame"));
ok("prompt includes the guide", prompt.includes(GAME_AUTHORING_GUIDE.slice(0, 80)));
ok("prompt includes the skeleton", prompt.includes("Polyglot.setActions"));
ok("prompt lists the existing games", prompt.includes("dice-rogue"));
ok("prompt lists the bridge members", prompt.includes("Polyglot.report"));

// ---------- the example we give the agent must pass our own validator ----------

const v = validateMinigameHtml(GAME_SKELETON_HTML);
ok("the skeleton example is itself a valid game", v.ok, v.error);
ok("the skeleton uses the bridge", GAME_SKELETON_HTML.includes("Polyglot.report"));
ok("the skeleton is self-contained", !/https?:\/\//.test(GAME_SKELETON_HTML));
ok("the skeleton has exactly one script block", (GAME_SKELETON_HTML.match(/<script/g) || []).length === 1);

// ---------- a realistic agent proposal ----------

const agentReply = [
  "Here is the game.",
  "```tool",
  JSON.stringify({
    action: "create_minigame",
    key: "dice-rogue",
    name: "Dice Rogue",
    desc: "Roll for treasure, dodge for your life.",
    html: GAME_SKELETON_HTML
  }),
  "```"
].join("\n");

const parsed = parseSupervisorReply(agentReply);
eq("one action parsed", parsed.actions.length, 1);
eq("action name", parsed.actions[0].action, "create_minigame");
eq("no skipped blocks", parsed.skipped.length, 0);

const act = parsed.actions[0];
eq("a well formed game validates", validateAction(act), null);
ok("the action appears in the approval card", describeAction(act, []).includes("Dice Rogue"), describeAction(act, []));

// ---------- rejected proposals ----------

eq("empty html is rejected", validateAction({ action: "create_minigame", key: "x", name: "X", html: "" }) !== null, true);
eq("missing key is rejected", validateAction({ action: "create_minigame", name: "X", html: "<script>Polyglot</script>" }) !== null, true);
eq("missing name is rejected", validateAction({ action: "create_minigame", key: "x", html: "<script>Polyglot</script>" }) !== null, true);
eq("a scriptless game is rejected", validateAction({ action: "create_minigame", key: "x", name: "X", html: "<p>hi</p>" }) !== null, true);
eq("a game without the bridge is rejected", validateAction({ action: "create_minigame", key: "x", name: "X", html: "<script>var a=1;</script>" }) !== null, true);
eq("an external url is rejected", validateAction({
  action: "create_minigame", key: "x", name: "X",
  html: "<script src='https://evil.example/a.js'></script><script>Polyglot</script>"
}) !== null, true);
eq("a network call is rejected", validateAction({
  action: "create_minigame", key: "x", name: "X",
  html: "<script>fetch('https://evil.example');Polyglot</script>"
}) !== null, true);
eq("an oversized game is rejected", validateAction({
  action: "create_minigame", key: "x", name: "X", html: "Polyglot" + "x".repeat(200001)
}) !== null, true);
eq("delete without a key is rejected", validateAction({ action: "delete_minigame" }) !== null, true);
eq("get without a key is rejected", validateAction({ action: "get_minigame" }) !== null, true);
eq("list_minigames needs nothing", validateAction({ action: "list_minigames" }), null);

// ---------- key hygiene ----------

eq("keys are slugged", slugKey("Dice Rogue!"), "dice-rogue");
eq("a key survives the round trip", slugKey(slugKey("Dice Rogue!"), "g"), "dice-rogue");

// ---------- report ----------

console.log("PASS " + pass);
if (fail) {
  console.log("FAIL " + fail);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("FORGE_GAME_TESTS_OK");
