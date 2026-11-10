/* Model catalog + capability filtering.
   Guards the provider /models metadata path: untrusted payloads normalize to a
   tiny record, search/metadata formatting stays pure, provider reasoning
   metadata reaches the thinking resolver, and buildPayload drops sampler keys
   a model does not advertise. Run: node tools/model-catalog.test.mjs */

import {
  normalizeModelCatalog,
  modelMetaFor,
  filterModels,
  reasoningDescriptor,
  capabilitySet,
  capabilityAllows,
  formatContext,
  formatPricePerMillion,
  formatPricePair
} from "../js/model-catalog.js";
import { mergeReasoning, validDescriptor } from "../js/reasoning-modes.js";
import { buildPayload, fetchModelCatalog, fetchModels } from "../js/api-client.js";

let failures = 0;
function check(ok, label) {
  if (ok) console.log("ok   " + label);
  else {
    failures++;
    console.log("FAIL " + label);
  }
}

const raw = {
  data: [
    {
      id: "openrouter/alpha",
      name: "Alpha",
      context_length: 128000,
      top_provider: { max_completion_tokens: 8192 },
      pricing: { prompt: "0.000003", completion: "0.000015" },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["temperature", "top_p", "max_tokens", "stop", "reasoning"],
      reasoning: { default_effort: "high", supported_efforts: ["low", "high"], mandatory: false }
    },
    {
      id: "free/model",
      name: "Free Model",
      context_length: 32000,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: [],
      architecture: {}
    },
    "plain/model",
    { id: "openrouter/alpha", name: "duplicate" },
    { id: "" },
    null
  ]
};

const catalog = normalizeModelCatalog(raw);
check(catalog.length === 3, "duplicates and empty rows are dropped");
check(catalog[0].id === "openrouter/alpha", "object ids survive");
check(catalog[0].name === "Alpha", "names survive");
check(catalog[0].context_length === 128000, "context_length parsed");
check(catalog[0].max_completion_tokens === 8192, "top_provider max completion parsed");
check(catalog[0].pricing.prompt === 0.000003, "string pricing parsed as a number");
check(catalog[0].input_modalities.join(",") === "text,image", "input modalities normalized");
check(catalog[0].output_modalities.join(",") === "text", "output modalities normalized");
check(catalog[0].supported_parameters.includes("reasoning"), "supported parameters normalized");
check(catalog[0].reasoning.supported_efforts.join("|") === "low|high", "reasoning efforts normalized");
check(catalog[1].supported_parameters.length === 0, "empty capability list stays empty");
check(catalog[2].id === "plain/model" && catalog[2].name === "plain/model", "bare string rows become records");
check(catalog[2].context_length === null && catalog[2].pricing === null, "bare ids have null metadata");

const normalizeAlt = normalizeModelCatalog([
  { id: "x/y", pricing: { prompt: null, completion: null } }
]);
check(normalizeAlt[0].pricing.prompt === null, "null pricing is not mistaken for free");

check(modelMetaFor(catalog, "OPENROUTER/ALPHA")?.name === "Alpha", "model lookup is case-insensitive");
check(modelMetaFor(catalog, "missing/model") === null, "unknown model has no metadata");
check(modelMetaFor(catalog, "") === null, "empty model has no metadata");

const searched = filterModels(catalog, "free");
check(searched.length === 1 && searched[0].id === "free/model", "search matches ids");
const byName = filterModels(catalog, "alpha");
check(byName.length === 1 && byName[0].id === "openrouter/alpha", "search matches names");
const all = filterModels(catalog, "");
check(all.map((m) => m.id).join(",") === "free/model,openrouter/alpha,plain/model", "empty search sorts by id");
check(filterModels(catalog, "", 1).length === 1, "limit slices results");
check(filterModels(catalog, "nope").length === 0, "no match returns an empty list");

check(formatContext(128000) === "128k", "context formats thousands");
check(formatContext(1000000) === "1M", "context formats millions");
check(formatContext(1500000) === "1.5M", "context formats fractional millions");
check(formatContext(10000000) === "10M", "context rounds large millions");
check(formatContext(999) === "999", "context keeps small values");
check(formatContext(null) === "" && formatContext("") === "", "context ignores empty values");
check(formatPricePerMillion(0.000003) === "$3", "price formats per million");
check(formatPricePerMillion(0.000015) === "$15", "price formats two-digit millions");
check(formatPricePerMillion(0.0000005) === "$0.5", "price formats sub-dollar millions");
check(formatPricePerMillion(0) === "free", "zero price is free");
check(formatPricePerMillion(null) === "", "missing price is blank");
check(formatPricePerMillion(-1) === "", "negative price is blank");
check(formatPricePair({ prompt: "0.000003", completion: "0.000015" }) === "$3/M in / $15/M out", "price pair labels per million");
check(formatPricePair({ prompt: "0", completion: "0" }) === "free", "free pair collapses");
check(formatPricePair({ prompt: "0.000001", completion: null }) === "$1/M in / ? out", "half-known pair keeps the unknown side");
check(formatPricePair(null) === "", "missing pricing has no pair");

const descriptor = reasoningDescriptor(catalog[0]);
check(descriptor?.source === "provider", "reasoning descriptor is provider-sourced");
check(descriptor?.effort?.values.join("|") === "low|high", "reasoning descriptor carries efforts");
check(descriptor?.effort?.default === "high", "reasoning descriptor carries the default effort");
check(descriptor?.always_thinks === undefined, "non-mandatory reasoning is not always-on");

const mandatory = reasoningDescriptor({ id: "x/think", reasoning: { supported_efforts: ["low", "high"], mandatory: true } });
check(mandatory?.always_thinks === true, "mandatory reasoning without none is always-on");
const mandatoryWithNone = reasoningDescriptor({ id: "x/think", reasoning: { supported_efforts: ["none", "high"], mandatory: true } });
check(mandatoryWithNone?.always_thinks === undefined, "mandatory reasoning with none stays disableable");
check(reasoningDescriptor({ id: "x/plain" }) === null, "no reasoning metadata means no descriptor");

check(capabilitySet(null) === null, "missing capabilities are unknown");
check(capabilitySet({ supported_parameters: [] }) === null, "empty capabilities are unknown");
check(capabilityAllows(null, "temperature") === true, "unknown capabilities keep old behavior");
check(capabilityAllows(catalog[0], "TEMPERATURE") === true, "capability lookup is case-insensitive");
check(capabilityAllows(catalog[0], "frequency_penalty") === false, "unsupported capability is rejected");

check(validDescriptor({ source: "provider", model: "x", effort: { values: ["low"] } }, "x")?.source === "provider", "provider descriptors validate");
const merged = mergeReasoning({
  model: "openrouter/alpha",
  model_meta: catalog[0],
  reasoning_mode: "effort",
  reasoning_value: "low"
});
check(merged.descriptor?.source === "provider", "preset model_meta feeds the thinking resolver");
check(merged.descriptor?.effort?.values.join("|") === "low|high", "preset model_meta keeps its effort list");
const mismatched = mergeReasoning({
  model: "openrouter/other",
  model_meta: catalog[0],
  reasoning_mode: "effort"
});
check(mismatched.descriptor === null, "metadata from a different model is ignored");

const samplers = {
  temperature: 0.5,
  top_p: 0.9,
  max_tokens: 321,
  frequency_penalty: 0.2,
  presence_penalty: 0.1,
  stop: ["END"]
};
const filtered = buildPayload({
  model: "openrouter/alpha",
  model_meta: catalog[0],
  samplers,
  reasoning_mode: "off"
}, [{ role: "user", content: "hi" }]);
check(!("frequency_penalty" in filtered.body), "unsupported frequency penalty is omitted");
check(!("presence_penalty" in filtered.body), "unsupported presence penalty is omitted");
check(filtered.body.temperature === 0.5, "supported temperature is kept");
check(filtered.body.top_p === 0.9, "supported top_p is kept");
check(filtered.body.max_tokens === 321, "supported max_tokens is kept");
check(filtered.body.stop.join("|") === "END", "supported stop is kept");
check(filtered.notes.some((n) => n.startsWith("E_CAP_SKIP:") && n.includes("frequency_penalty")), "capability skips are reported");

const bare = buildPayload({
  model: "test/model",
  samplers,
  reasoning_mode: "off"
}, [{ role: "user", content: "hi" }]);
check(bare.body.temperature === 0.5, "presets without metadata keep temperature");
check(bare.body.frequency_penalty === 0.2, "presets without metadata keep frequency penalty");
check(bare.body.presence_penalty === 0.1, "presets without metadata keep presence penalty");
check(!bare.notes.some((n) => n.startsWith("E_CAP_SKIP:")), "no capability notes without metadata");

const narrow = buildPayload({
  model: "narrow/model",
  model_meta: { id: "narrow/model", supported_parameters: ["MAX_TOKENS"] },
  samplers,
  reasoning_mode: "off"
}, [{ role: "user", content: "hi" }]);
check(!("temperature" in narrow.body), "capability matching is case-insensitive");
check(narrow.body.max_tokens === 321, "case-insensitive supported max_tokens is kept");
check(narrow.notes.some((n) => n.includes("temperature")), "omitted temperature is named");

const thinking = buildPayload({
  model: "openrouter/alpha",
  model_meta: catalog[0],
  samplers: { ...samplers, frequency_penalty: 0, presence_penalty: 0 },
  reasoning_mode: "effort",
  reasoning_value: "low"
}, [{ role: "user", content: "hi" }]);
check(thinking.body.reasoning_effort === "low", "provider reasoning knob still reaches the payload");
check(!("temperature" in thinking.body) === false, "sampler filtering does not disturb reasoning");

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), headers: opts.headers || {} });
  return new Response(JSON.stringify(raw), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

const fetched = await fetchModelCatalog({
  base_url: "https://openrouter.ai/api/v1",
  api_key: "test-secret"
});
check(fetched.length === 3, "fetchModelCatalog returns normalized records");
check(calls[0].url === "https://openrouter.ai/api/v1/models", "fetchModelCatalog hits /models");
check(calls[0].headers.Authorization === "Bearer test-secret", "fetchModelCatalog sends the key in the header");
check(!calls[0].url.includes("test-secret"), "the key never enters the URL");

const ids = await fetchModels({ base_url: "https://openrouter.ai/api/v1", api_key: "test-secret" });
check(ids.join(",") === "openrouter/alpha,free/model,plain/model", "fetchModels keeps the id-list return shape");

console.log(failures ? `MODEL_CATALOG_FAIL (${failures})` : "MODEL_CATALOG_OK");
process.exitCode = failures ? 1 : 0;
