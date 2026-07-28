import { BaseProvider } from '~/lib/modules/llm/base-provider';
import type { ModelInfo } from '~/lib/modules/llm/types';
import type { IProviderSetting } from '~/types/model';
import type { LanguageModelV1 } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

interface OpenRouterModel {
  name: string;
  id: string;
  context_length: number;
  pricing: {
    prompt: number;
    completion: number;
  };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

/**
 * Curated OpenRouter models shown at the top of the models dropdown.
 * Order is intentional and preserved in the UI.
 * Labels are display names only (no pricing / context suffixes).
 */
export const CURATED_OPENROUTER_MODELS: ModelInfo[] = [
  {
    name: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'OpenRouter',
    maxTokenAllowed: 200000,
  },
  {
    name: '~anthropic/claude-haiku-latest',
    label: 'Claude Haiku Latest',
    provider: 'OpenRouter',
    maxTokenAllowed: 200000,
  },
  {
    name: 'google/gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    provider: 'OpenRouter',
    maxTokenAllowed: 1000000,
  },
  {
    name: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    provider: 'OpenRouter',
    maxTokenAllowed: 256000,
  },
  {
    name: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    provider: 'OpenRouter',
    maxTokenAllowed: 256000,
  },
  {
    name: 'x-ai/grok-4.20',
    label: 'Grok 4.20',
    provider: 'OpenRouter',
    maxTokenAllowed: 256000,
  },
  {
    name: 'x-ai/grok-4.3',
    label: 'Grok 4.3',
    provider: 'OpenRouter',
    maxTokenAllowed: 256000,
  },
  {
    name: 'x-ai/grok-build-0.1',
    label: 'Grok Build',
    provider: 'OpenRouter',
    maxTokenAllowed: 256000,
  },
  {
    name: 'openrouter/free',
    label: 'OpenRouter Free',
    provider: 'OpenRouter',
    maxTokenAllowed: 200000,
  },
  {
    name: 'openrouter/auto',
    label: 'OpenRouter Auto',
    provider: 'OpenRouter',
    maxTokenAllowed: 200000,
  },
  {
    name: 'openrouter/fusion',
    label: 'OpenRouter Fusion',
    provider: 'OpenRouter',
    maxTokenAllowed: 200000,
  },
  {
    name: 'moonshotai/kimi-k2.6',
    label: 'Kimi K2.6',
    provider: 'OpenRouter',
    maxTokenAllowed: 256000,
  },
  {
    name: 'moonshotai/kimi-k2.7-code',
    label: 'Kimi K2.7',
    provider: 'OpenRouter',
    maxTokenAllowed: 256000,
  },
  {
    name: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    provider: 'OpenRouter',
    maxTokenAllowed: 128000,
  },
  {
    name: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'OpenRouter',
    maxTokenAllowed: 128000,
  },
  {
    name: 'sakana/fugu-ultra',
    label: 'Sakana Fugu',
    provider: 'OpenRouter',
    maxTokenAllowed: 128000,
  },
];

const CURATED_IDS = new Set(CURATED_OPENROUTER_MODELS.map((m) => m.name));
const CURATED_ORDER = new Map(CURATED_OPENROUTER_MODELS.map((m, i) => [m.name, i]));

export function getOpenRouterModelOrder(modelName: string): number {
  return CURATED_ORDER.has(modelName) ? (CURATED_ORDER.get(modelName) as number) : 10000;
}

export default class OpenRouterProvider extends BaseProvider {
  name = 'OpenRouter';
  getApiKeyLink = 'https://openrouter.ai/settings/keys';

  config = {
    apiTokenKey: 'OPEN_ROUTER_API_KEY',
  };

  staticModels: ModelInfo[] = CURATED_OPENROUTER_MODELS;

  async getDynamicModels(
    _apiKeys?: Record<string, string>,
    _settings?: IProviderSetting,
    _serverEnv: Record<string, string> = {},
  ): Promise<ModelInfo[]> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        return CURATED_OPENROUTER_MODELS;
      }

      const data = (await response.json()) as OpenRouterModelsResponse;
      const byId = new Map(data.data.map((m) => [m.id, m]));

      // Prefer live context windows when available; keep clean name-only labels.
      return CURATED_OPENROUTER_MODELS.map((staticModel) => {
        const live = byId.get(staticModel.name);

        if (!live) {
          return staticModel;
        }

        const contextWindow = live.context_length || staticModel.maxTokenAllowed || 32000;
        const maxAllowed = 1000000;
        const finalContext = Math.min(contextWindow, maxAllowed);

        return {
          name: staticModel.name,
          label: staticModel.label,
          provider: this.name,
          maxTokenAllowed: finalContext,
        };
      }).filter((m) => CURATED_IDS.has(m.name));
    } catch (error) {
      console.error('Error getting OpenRouter models:', error);
      return CURATED_OPENROUTER_MODELS;
    }
  }

  getModelInstance(options: {
    model: string;
    serverEnv: Env;
    apiKeys?: Record<string, string>;
    providerSettings?: Record<string, IProviderSetting>;
  }): LanguageModelV1 {
    const { model, serverEnv, apiKeys, providerSettings } = options;

    const { apiKey } = this.getProviderBaseUrlAndKey({
      apiKeys,
      providerSettings: providerSettings?.[this.name],
      serverEnv: serverEnv as any,
      defaultBaseUrlKey: '',
      defaultApiTokenKey: 'OPEN_ROUTER_API_KEY',
    });

    if (!apiKey) {
      throw new Error(`Missing API key for ${this.name} provider`);
    }

    const openRouter = createOpenRouter({
      apiKey,
    });
    const instance = openRouter.chat(model) as LanguageModelV1;

    return instance;
  }
}
