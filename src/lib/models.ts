import { functionCallingModelIds, prebuiltAppConfig } from "@mlc-ai/web-llm";
import type { ModelOption } from "../types";

const toolCallingIds = new Set(functionCallingModelIds);

export const TOOL_CALLING_MODELS: ModelOption[] = prebuiltAppConfig.model_list
  .filter((model) => toolCallingIds.has(model.model_id))
  .map((model) => ({
    id: model.model_id,
    label: model.model_id,
    lowResource: Boolean(model.low_resource_required),
    vramRequiredMB: model.vram_required_MB,
  }));

export const TOOL_CALLING_APP_CONFIG = {
  useIndexedDBCache: false,
  model_list: prebuiltAppConfig.model_list.filter((model) =>
    toolCallingIds.has(model.model_id),
  ),
};

export const DEFAULT_MODEL_ID =
  TOOL_CALLING_MODELS.find((model) =>
    model.id.includes("Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC"),
  )?.id ?? TOOL_CALLING_MODELS[0]?.id ?? "";
