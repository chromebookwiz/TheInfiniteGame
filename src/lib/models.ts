import type { AppConfig } from "@mlc-ai/web-llm";
import type { ModelOption } from "../types";

let catalogPromise:
  | Promise<{
  models: ModelOption[];
  defaultModelId: string;
  appConfig: AppConfig;
}>
  | undefined;

export async function loadToolCallingCatalog() {
  if (!catalogPromise) {
    catalogPromise = import("@mlc-ai/web-llm").then(
      ({ functionCallingModelIds, prebuiltAppConfig }) => {
        const toolCallingIds = new Set(functionCallingModelIds);
        const modelList = prebuiltAppConfig.model_list.filter((model) =>
          toolCallingIds.has(model.model_id),
        );
        const models: ModelOption[] = modelList.map((model) => ({
          id: model.model_id,
          label: model.model_id,
          lowResource: Boolean(model.low_resource_required),
          vramRequiredMB: model.vram_required_MB,
        }));

        return {
          models,
          defaultModelId:
            models.find((model) =>
              model.id.includes("Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC"),
            )?.id ?? models[0]?.id ?? "",
          appConfig: {
            useIndexedDBCache: false,
            model_list: modelList,
          },
        };
      },
    );
  }

  return catalogPromise;
}

export async function getToolCallingModels(): Promise<ModelOption[]> {
  return (await loadToolCallingCatalog()).models;
}

export async function getDefaultModelId(): Promise<string> {
  return (await loadToolCallingCatalog()).defaultModelId;
}

export async function getToolCallingAppConfig() {
  return (await loadToolCallingCatalog()).appConfig;
}
