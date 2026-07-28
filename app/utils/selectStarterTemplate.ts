import ignore from 'ignore';
import type { ProviderInfo } from '~/types/model';
import type { Template } from '~/types/template';
import { STARTER_TEMPLATES } from './constants';

const starterTemplateSelectionPrompt = (templates: Template[]) => `
You are an experienced developer who helps people choose the best starter template for their projects.
IMPORTANT: Vite is preferred.
IMPORTANT: Only choose shadcn templates if the user explicitly asks for shadcn.
IMPORTANT: templateName must exactly match one of the names listed below, or blank.

Available templates:
<template>
  <name>blank</name>
  <description>Empty starter for simple scripts and trivial tasks that don't require a full template setup</description>
  <tags>basic, script</tags>
</template>
${templates
  .map(
    (template) => `
<template>
  <name>${template.name}</name>
  <description>${template.description}</description>
  ${template.tags ? `<tags>${template.tags.join(', ')}</tags>` : ''}
</template>
`,
  )
  .join('\n')}

Response Format:
<selection>
  <templateName>{exact selected template name}</templateName>
  <title>{a proper title for the project}</title>
</selection>

Examples:

<example>
User: I need to build a todo app in React
Response:
<selection>
  <templateName>Vite React</templateName>
  <title>React todo application</title>
</selection>
</example>

<example>
User: Write a script to generate numbers from 1 to 100
Response:
<selection>
  <templateName>blank</templateName>
  <title>Number generation script</title>
</selection>
</example>

Instructions:
1. For trivial tasks and simple scripts, recommend blank.
2. For applications, recommend exactly one template from the provided list.
3. Follow the exact XML format.
4. Never invent or rename a template.
5. Provide only the selection tags, with no additional text.
`;

const parseSelectedTemplate = (llmOutput: string): { template: string; title: string } | null => {
  try {
    const templateNameMatch = llmOutput.match(/<templateName>(.*?)<\/templateName>/s);
    const titleMatch = llmOutput.match(/<title>(.*?)<\/title>/s);

    if (!templateNameMatch) {
      return null;
    }

    return {
      template: templateNameMatch[1].trim(),
      title: titleMatch?.[1].trim() || 'Untitled Project',
    };
  } catch (error) {
    console.error('Error parsing template selection:', error);
    return null;
  }
};

const TEMPLATE_ALIASES: Record<string, string> = {
  'react-basic-starter': 'Vite React',
  'react-vite': 'Vite React',
  'vite-react': 'Vite React',
  'vite react typescript': 'Vite React',
  'next.js': 'NextJS Shadcn',
  nextjs: 'NextJS Shadcn',
  astro: 'Basic Astro',
  expo: 'Expo App',
  remix: 'Remix Typescript',
  svelte: 'Sveltekit',
  sveltekit: 'Sveltekit',
  angular: 'Angular',
  vue: 'Vue',
  solid: 'SolidJS',
  solidjs: 'SolidJS',
};

function normalizeTemplateName(templateName: string, availableTemplates: Template[]): string | null {
  const normalized = templateName.trim().toLowerCase();

  if (normalized === 'blank') {
    return 'blank';
  }

  const directMatch = availableTemplates.find(
    (template) => template.name.toLowerCase() === normalized || template.label.toLowerCase() === normalized,
  );

  if (directMatch) {
    return directMatch.name;
  }

  const alias = TEMPLATE_ALIASES[normalized];

  if (!alias) {
    return null;
  }

  return availableTemplates.some((template) => template.name === alias) ? alias : null;
}

function inferStarterTemplate(message: string, availableTemplates: Template[]): string {
  const input = message.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/\b(expo|react native|android|ios|mobile app)\b/, 'Expo App'],
    [/\b(next(?:\.js|js)?|server components)\b/, 'NextJS Shadcn'],
    [/\b(astro)\b/, 'Basic Astro'],
    [/\b(remix)\b/, 'Remix Typescript'],
    [/\b(qwik)\b/, 'Qwik Typescript'],
    [/\b(svelte|sveltekit)\b/, 'Sveltekit'],
    [/\b(vue)\b/, 'Vue'],
    [/\b(angular)\b/, 'Angular'],
    [/\b(solid|solidjs)\b/, 'SolidJS'],
    [/\b(slidev|presentation deck)\b/, 'Slidev'],
    [/\b(vanilla javascript|vanilla js)\b/, 'Vanilla Vite'],
    [/\b(react|todo|dashboard|website|web app|spa|application)\b/, 'Vite React'],
    [/\b(typescript|vite)\b/, 'Vite Typescript'],
  ];

  for (const [pattern, templateName] of candidates) {
    if (pattern.test(input) && availableTemplates.some((template) => template.name === templateName)) {
      return templateName;
    }
  }

  return 'blank';
}

export const selectStarterTemplate = async (options: { message: string; model: string; provider: ProviderInfo }) => {
  const { message, model, provider } = options;
  const explicitlyRequestsShadcn = /\bshadcn(?:\/ui)?\b/i.test(message);
  const availableTemplates = explicitlyRequestsShadcn
    ? STARTER_TEMPLATES
    : STARTER_TEMPLATES.filter((template) => !template.name.toLowerCase().includes('shadcn'));
  const fallbackTemplate = inferStarterTemplate(message, availableTemplates);

  try {
    const response = await fetch('/api/llmcall', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        model,
        provider,
        system: starterTemplateSelectionPrompt(availableTemplates),
      }),
    });

    if (!response.ok) {
      throw new Error(`Template selection failed with status ${response.status}`);
    }

    const respJson = (await response.json()) as { text?: string };
    const selectedTemplate = respJson.text ? parseSelectedTemplate(respJson.text) : null;
    const normalizedTemplate = selectedTemplate
      ? normalizeTemplateName(selectedTemplate.template, availableTemplates)
      : null;

    if (normalizedTemplate) {
      return {
        template: normalizedTemplate,
        title: selectedTemplate?.title || 'Untitled Project',
      };
    }

    console.warn('Template selector returned an unknown template; using deterministic fallback', {
      selected: selectedTemplate?.template,
      fallbackTemplate,
    });
  } catch (error) {
    console.warn('Template selection request failed; using deterministic fallback', error);
  }

  return {
    template: fallbackTemplate,
    title: message.slice(0, 80).trim() || 'Untitled Project',
  };
};

const getGitHubRepoContent = async (repoName: string): Promise<{ name: string; path: string; content: string }[]> => {
  const response = await fetch(`/api/github-template?repo=${encodeURIComponent(repoName)}`);
  const payload = (await response.json().catch(() => null)) as
    | { name: string; path: string; content: string }[]
    | { error?: string; details?: string }
    | null;

  if (!response.ok) {
    const details = payload && !Array.isArray(payload) ? payload.details || payload.error : undefined;
    throw new Error(details || `Template import failed with status ${response.status}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error('Template import returned an invalid response');
  }

  return payload;
};

export async function getTemplates(templateName: string, title?: string) {
  const template = STARTER_TEMPLATES.find((candidate) => candidate.name === templateName);

  if (!template) {
    throw new Error(`Unknown starter template: ${templateName}`);
  }

  const files = await getGitHubRepoContent(template.githubRepo);
  let filteredFiles = files.filter((file) => !file.path.startsWith('.git'));

  filteredFiles = filteredFiles.filter((file) => !file.path.startsWith('.bolt'));

  const templateIgnoreFile = files.find((file) => file.path.startsWith('.bolt') && file.name === 'ignore');
  const filesToImport = {
    files: filteredFiles,
    ignoreFile: [] as typeof filteredFiles,
  };

  if (templateIgnoreFile) {
    const ignorePatterns = templateIgnoreFile.content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const ignoredMatcher = ignore().add(ignorePatterns);
    const ignoredFiles = filteredFiles.filter((file) => ignoredMatcher.ignores(file.path));

    filesToImport.files = filteredFiles;
    filesToImport.ignoreFile = ignoredFiles;
  }

  const assistantMessage = `
Chinna is initializing your project with the required files using the ${template.name} template.
<boltArtifact id="imported-files" title="${title || 'Create initial files'}" type="bundled">
${filesToImport.files
  .map(
    (file) =>
      `<boltAction type="file" filePath="${file.path}">
${file.content}
</boltAction>`,
  )
  .join('\n')}
</boltArtifact>
`;
  let userMessage = '';
  const templatePromptFile = files.find((file) => file.path.startsWith('.bolt') && file.name === 'prompt');

  if (templatePromptFile) {
    userMessage = `
TEMPLATE INSTRUCTIONS:
${templatePromptFile.content}

---
`;
  }

  if (filesToImport.ignoreFile.length > 0) {
    userMessage += `
STRICT FILE ACCESS RULES - READ CAREFULLY:

The following files are READ-ONLY and must never be modified:
${filesToImport.ignoreFile.map((file) => `- ${file.path}`).join('\n')}

Permitted actions:
✓ Import these files as dependencies
✓ Read from these files
✓ Reference these files

Strictly forbidden actions:
❌ Modify any content within these files
❌ Delete these files
❌ Rename these files
❌ Move these files
❌ Create new versions of these files
❌ Suggest changes to these files

If functionality must change, create new files instead of modifying the protected files listed above.
---
`;
  }

  userMessage += `
---
Template import is complete. Continue with the original request and edit only the files that require changes.
---
Install dependencies and start the application with: npm install && npm run dev
`;

  return {
    assistantMessage,
    userMessage,
  };
}
