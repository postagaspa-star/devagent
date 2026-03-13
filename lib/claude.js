import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';

/**
 * Tool definitions for Claude Code development
 */
const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file from the project. Use this to understand existing code before making changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { 
          type: 'string', 
          description: 'Path relative to the project root (e.g., "src/index.js", "package.json")' 
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the project. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { 
          type: 'string', 
          description: 'Path relative to the project root' 
        },
        content: { 
          type: 'string', 
          description: 'Complete file content to write' 
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files and directories in a path. Use this to explore the project structure.',
    input_schema: {
      type: 'object',
      properties: {
        path: { 
          type: 'string', 
          description: 'Path relative to project root, use "." for root',
          default: '.'
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list recursively',
          default: false
        }
      }
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project.',
    input_schema: {
      type: 'object',
      properties: {
        path: { 
          type: 'string', 
          description: 'Path relative to the project root' 
        }
      },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description: 'Search for files containing a specific text pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { 
          type: 'string', 
          description: 'Text pattern to search for' 
        },
        path: { 
          type: 'string', 
          description: 'Directory to search in (relative to project root)',
          default: '.'
        }
      },
      required: ['pattern']
    }
  }
];

/**
 * System prompts for different agent modes
 */
const SYSTEM_PROMPTS = {
  develop: `You are DevAgent, an expert autonomous software developer. You are working on a project and must accomplish the given objective.

CAPABILITIES:
- Read, write, and modify files using the provided tools
- Understand project structure and dependencies
- Write clean, maintainable, production-ready code
- Follow best practices for the languages/frameworks involved

WORKFLOW:
1. First, explore the project structure using list_files
2. Read relevant existing files to understand the codebase
3. Plan your changes carefully
4. Implement changes using write_file
5. Verify your changes are complete and correct

GUIDELINES:
- Always read existing code before modifying it
- Maintain consistent code style with the existing codebase
- Add appropriate comments and documentation
- Handle errors gracefully
- Consider edge cases
- If you need to create new files, ensure proper directory structure

OUTPUT FORMAT:
After completing changes, provide a summary of:
- Files modified/created
- Key changes made
- Any potential issues or recommendations

When you believe you have completed the objective, state clearly: "OBJECTIVE_COMPLETE" followed by a summary.`,

  review: `You are a senior code reviewer. Review the following code changes for:

1. CRITICAL ISSUES (must fix):
   - Syntax errors
   - Logic bugs
   - Security vulnerabilities
   - Breaking changes

2. WARNINGS (should fix):
   - Performance issues
   - Code style inconsistencies
   - Missing error handling
   - Potential edge cases

3. SUGGESTIONS (nice to have):
   - Code organization improvements
   - Better naming
   - Additional documentation

Respond in JSON format:
{
  "criticalIssues": [{"file": "path", "line": number, "issue": "description", "fix": "suggestion"}],
  "warnings": [{"file": "path", "line": number, "issue": "description"}],
  "suggestions": [{"file": "path", "suggestion": "description"}],
  "overallAssessment": "PASS" | "NEEDS_FIXES",
  "summary": "Brief summary of the review"
}`,

  verify: `You are verifying whether a development objective has been achieved. 

Analyze the conversation history and the current state of the project to determine:
1. Has the primary objective been fully completed?
2. Are there any remaining tasks or issues?
3. Is the implementation production-ready?

Respond in JSON format:
{
  "objectiveReached": true | false,
  "completedTasks": ["list of completed items"],
  "remainingTasks": ["list of remaining items if any"],
  "issues": ["any blocking issues"],
  "confidence": 0-100,
  "recommendation": "COMPLETE" | "CONTINUE" | "REVIEW_NEEDED"
}`
};

/**
 * Claude API Client wrapper for DevAgent
 */
export class ClaudeClient {
  constructor(apiKey) {
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is required');
    }
    this.client = new Anthropic({ apiKey });
    this.defaultModel = 'claude-sonnet-4-5-20250929';
  }

  /**
   * Basic chat completion
   */
  async chat(messages, options = {}) {
    const model = options.model || this.defaultModel;
    
    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: options.maxTokens || 8000,
        messages,
        system: options.system || undefined,
        tools: options.tools || undefined,
        temperature: options.temperature ?? 0.7
      });

      return response;
    } catch (error) {
      console.error('Claude API Error:', error.message);
      throw error;
    }
  }

  /**
   * Execute tool calls from Claude's response
   */
  async executeToolCalls(toolCalls, projectPath) {
    const results = [];

    for (const toolUse of toolCalls) {
      const { name, input, id } = toolUse;
      let result;

      try {
        switch (name) {
          case 'read_file':
            result = await this.toolReadFile(projectPath, input.path);
            break;
          case 'write_file':
            result = await this.toolWriteFile(projectPath, input.path, input.content);
            break;
          case 'list_files':
            result = await this.toolListFiles(projectPath, input.path || '.', input.recursive);
            break;
          case 'delete_file':
            result = await this.toolDeleteFile(projectPath, input.path);
            break;
          case 'search_files':
            result = await this.toolSearchFiles(projectPath, input.pattern, input.path || '.');
            break;
          default:
            result = { error: `Unknown tool: ${name}` };
        }
      } catch (error) {
        result = { error: error.message };
      }

      results.push({
        type: 'tool_result',
        tool_use_id: id,
        content: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      });
    }

    return results;
  }

  /**
   * Tool: Read file contents
   */
  async toolReadFile(projectPath, filePath) {
    const fullPath = path.join(projectPath, filePath);
    
    // Security: ensure path is within project
    if (!fullPath.startsWith(projectPath)) {
      throw new Error('Access denied: path outside project');
    }

    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return `File not found: ${filePath}`;
      }
      throw error;
    }
  }

  /**
   * Tool: Write file contents
   */
  async toolWriteFile(projectPath, filePath, content) {
    const fullPath = path.join(projectPath, filePath);
    
    // Security: ensure path is within project
    if (!fullPath.startsWith(projectPath)) {
      throw new Error('Access denied: path outside project');
    }

    // Create parent directories if needed
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    
    await fs.writeFile(fullPath, content, 'utf-8');
    return { success: true, path: filePath, bytes: content.length };
  }

  /**
   * Tool: List files in directory
   */
  async toolListFiles(projectPath, dirPath, recursive = false) {
    const fullPath = path.join(projectPath, dirPath);
    
    // Security: ensure path is within project
    if (!fullPath.startsWith(projectPath)) {
      throw new Error('Access denied: path outside project');
    }

    const listDir = async (dir, relativePath = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const result = [];

      for (const entry of entries) {
        // Skip hidden files and node_modules
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        const entryPath = path.join(relativePath, entry.name);
        
        if (entry.isDirectory()) {
          result.push({ name: entryPath, type: 'directory' });
          if (recursive) {
            const subEntries = await listDir(path.join(dir, entry.name), entryPath);
            result.push(...subEntries);
          }
        } else {
          result.push({ name: entryPath, type: 'file' });
        }
      }

      return result;
    };

    try {
      const files = await listDir(fullPath);
      return files;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { error: `Directory not found: ${dirPath}` };
      }
      throw error;
    }
  }

  /**
   * Tool: Delete file
   */
  async toolDeleteFile(projectPath, filePath) {
    const fullPath = path.join(projectPath, filePath);
    
    // Security: ensure path is within project
    if (!fullPath.startsWith(projectPath)) {
      throw new Error('Access denied: path outside project');
    }

    try {
      await fs.unlink(fullPath);
      return { success: true, deleted: filePath };
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { error: `File not found: ${filePath}` };
      }
      throw error;
    }
  }

  /**
   * Tool: Search files for pattern
   */
  async toolSearchFiles(projectPath, pattern, dirPath) {
    const fullPath = path.join(projectPath, dirPath);
    
    // Security: ensure path is within project
    if (!fullPath.startsWith(projectPath)) {
      throw new Error('Access denied: path outside project');
    }

    const results = [];
    
    const searchDir = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await searchDir(entryPath);
        } else if (entry.isFile()) {
          try {
            const content = await fs.readFile(entryPath, 'utf-8');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                results.push({
                  file: path.relative(projectPath, entryPath),
                  line: i + 1,
                  content: lines[i].trim().substring(0, 100)
                });
              }
            }
          } catch (error) {
            // Skip binary files or unreadable files
          }
        }
      }
    };

    await searchDir(fullPath);
    return results.slice(0, 50); // Limit results
  }

  /**
   * Development cycle with tool use
   */
  async developCode(objective, projectConfig, history = [], options = {}) {
    const messages = [
      ...history,
      {
        role: 'user',
        content: `PROJECT: ${projectConfig.name}
PATH: ${projectConfig.path}

OBJECTIVE: ${objective}

Use the available tools to explore the project and implement the required changes. 
Start by listing files to understand the project structure, then proceed with implementation.`
      }
    ];

    const plannedChanges = [];
    const filesChanged = new Set();
    let continueLoop = true;
    let iterations = 0;
    const maxToolIterations = 20;

    while (continueLoop && iterations < maxToolIterations) {
      iterations++;

      const response = await this.chat(messages, {
        model: options.model || this.defaultModel,
        system: SYSTEM_PROMPTS.develop,
        tools: TOOLS,
        maxTokens: 8000
      });

      // Process response content
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      // Check for tool use
      const toolUses = assistantContent.filter(block => block.type === 'tool_use');
      
      if (toolUses.length > 0) {
        // Execute tool calls
        const toolResults = await this.executeToolCalls(toolUses, projectConfig.path);
        messages.push({ role: 'user', content: toolResults });

        // Track file changes
        for (const toolUse of toolUses) {
          if (toolUse.name === 'write_file') {
            filesChanged.add(toolUse.input.path);
            plannedChanges.push({
              path: toolUse.input.path,
              action: 'modify',
              content: toolUse.input.content
            });
          } else if (toolUse.name === 'delete_file') {
            filesChanged.add(toolUse.input.path);
            plannedChanges.push({
              path: toolUse.input.path,
              action: 'delete'
            });
          }
        }
      } else {
        // No more tool calls, check if complete
        const textContent = assistantContent
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
        
        if (textContent.includes('OBJECTIVE_COMPLETE') || response.stop_reason === 'end_turn') {
          continueLoop = false;
        }
      }
    }

    return {
      history: messages,
      plannedChanges,
      filesChanged: Array.from(filesChanged),
      success: true
    };
  }

  /**
   * Code review
   */
  async reviewCode(filesContent) {
    const filesList = Object.entries(filesContent)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
      .join('\n\n');

    const response = await this.chat([
      {
        role: 'user',
        content: `Review the following code changes:\n\n${filesList}`
      }
    ], {
      system: SYSTEM_PROMPTS.review,
      temperature: 0.3
    });

    const textContent = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    try {
      // Extract JSON from response
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.error('Failed to parse review response:', error);
    }

    return {
      criticalIssues: [],
      warnings: [],
      suggestions: [],
      overallAssessment: 'PASS',
      summary: 'Review completed'
    };
  }

  /**
   * Verify if objective is complete
   */
  async verifyObjective(objective, history, projectConfig) {
    const recentHistory = history.slice(-10); // Last 10 messages
    
    const response = await this.chat([
      {
        role: 'user',
        content: `OBJECTIVE: ${objective}

PROJECT: ${projectConfig.name}

CONVERSATION HISTORY:
${JSON.stringify(recentHistory, null, 2)}

Based on the above, verify if the objective has been achieved.`
      }
    ], {
      system: SYSTEM_PROMPTS.verify,
      temperature: 0.2
    });

    const textContent = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    try {
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      console.error('Failed to parse verify response:', error);
    }

    return {
      objectiveReached: false,
      completedTasks: [],
      remainingTasks: ['Unable to verify'],
      issues: [],
      confidence: 0,
      recommendation: 'CONTINUE'
    };
  }

  /**
   * Get available tools
   */
  getTools() {
    return TOOLS;
  }
}

export default ClaudeClient;
