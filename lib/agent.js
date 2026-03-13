import { ClaudeClient } from './claude.js';
import { Deployer } from './deployer.js';
import { Tester } from './tester.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Autonomous Agent Engine
 * Core development loop with auto-review, deploy, test, and rollback
 */
export class AutonomousAgent {
  constructor(apiKey, globalConfig) {
    this.claude = new ClaudeClient(apiKey);
    this.deployer = new Deployer();
    this.tester = new Tester();
    this.config = globalConfig;
    
    // State
    this.isRunning = false;
    this.shouldStop = false;
    this.currentProjectId = null;
    this.wsClient = null;
    
    // Pending authorizations
    this.pendingAuthorizations = new Map();
  }

  /**
   * Main agent loop
   */
  async run(projectConfig, objective, options = {}) {
    const {
      autonomyLevel = 'full',
      model = 'claude-sonnet-4-5-20250929',
      wsClient = null
    } = options;

    this.isRunning = true;
    this.shouldStop = false;
    this.currentProjectId = projectConfig.id;
    this.wsClient = wsClient;

    const maxIterations = this.config.maxIterations || 15;
    let conversationHistory = [];
    let currentObjective = objective;
    let result = { success: false, reason: 'UNKNOWN' };

    console.log(`[Agent] Starting for project: ${projectConfig.name}`);
    console.log(`[Agent] Objective: ${objective}`);
    console.log(`[Agent] Autonomy: ${autonomyLevel}, Model: ${model}`);

    this.sendProgress('iteration', `Avvio agent con obiettivo: ${objective}`, '🚀');

    try {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        if (this.shouldStop) {
          console.log(`[Agent] Stopped by user`);
          result = { success: false, reason: 'STOPPED_BY_USER' };
          break;
        }

        this.sendProgress('iteration', `Iterazione ${iteration}/${maxIterations}`, '🔄');
        console.log(`[Agent] Iteration ${iteration}/${maxIterations}`);

        // ============ STEP 1: SVILUPPO ============
        this.sendProgress('develop', 'Claude sta sviluppando...', '💻');
        
        let devResult;
        try {
          devResult = await this.claude.developCode(
            currentObjective,
            projectConfig,
            conversationHistory,
            {
              model,
              onProgress: (stage, detail, preview) => {
                this.sendMessage({
                  type   : 'PROGRESS',
                  stage,
                  message: detail,
                  preview: preview || null,
                  path   : detail,
                  emoji  : stage === 'file_write'  ? '📝'
                         : stage === 'file_delete' ? '🗑'
                         : stage === 'bash'        ? '⚡'
                         : '👁',
                  timestamp: new Date().toISOString()
                });
              }
            }
          );
          conversationHistory = devResult.history;
        } catch (error) {
          console.error(`[Agent] Development error:`, error.message);
          this.sendProgress('error', `Errore sviluppo: ${error.message}`, '❌');
          
          // Try to recover
          currentObjective = this.buildFixPrompt(currentObjective, [error.message]);
          continue;
        }

        console.log(`[Agent] Files changed: ${devResult.filesChanged.join(', ') || 'none'}`);

        // ============ AUTHORIZATION CHECK ============
        if (autonomyLevel !== 'full' && devResult.plannedChanges.length > 0) {
          this.sendProgress('auth', 'In attesa di autorizzazione...', '🔐');
          
          const authResult = await this.requestAuthorization(
            devResult.plannedChanges,
            autonomyLevel
          );

          if (!authResult.approved) {
            console.log(`[Agent] Changes rejected by user`);
            this.sendProgress('warning', 'Modifiche rifiutate, revisione...', '⚠️');
            
            // Build revision prompt based on feedback
            currentObjective = this.buildRevisionPrompt(currentObjective, authResult.feedback);
            continue;
          }

          // Apply only approved changes
          if (authResult.approvedFiles && authResult.approvedFiles.length > 0) {
            devResult.plannedChanges = devResult.plannedChanges.filter(
              change => authResult.approvedFiles.includes(change.path)
            );
          }
        }

        // ============ STEP 2: AUTO-REVIEW ============
        if (devResult.filesChanged.length > 0) {
          this.sendProgress('review', 'Auto-review del codice...', '🔍');
          
          try {
            const filesContent = await this.getFilesContent(
              projectConfig.path,
              devResult.filesChanged
            );
            
            const reviewResult = await this.claude.reviewCode(filesContent);
            
            console.log(`[Agent] Review: ${reviewResult.overallAssessment}`);
            console.log(`[Agent] Critical issues: ${reviewResult.criticalIssues.length}`);

            if (reviewResult.criticalIssues.length > 0) {
              this.sendProgress('warning', `${reviewResult.criticalIssues.length} problemi critici trovati`, '⚠️');
              
              const issues = reviewResult.criticalIssues.map(i => 
                `${i.file}:${i.line} - ${i.issue}`
              );
              
              currentObjective = this.buildFixPrompt(currentObjective, issues);
              continue;
            }

            if (reviewResult.warnings.length > 0) {
              this.sendProgress('warning', `${reviewResult.warnings.length} warning (non bloccanti)`, '⚠️');
            }
          } catch (error) {
            console.error(`[Agent] Review error:`, error.message);
            // Non-blocking, continue
          }
        }

        // ============ STEP 3: DEPLOY ============
        if (projectConfig.deployment?.enabled) {
          this.sendProgress('deploy', 'Deploy in corso...', '🚀');
          
          // Create snapshot for rollback
          let snapshot;
          try {
            snapshot = await this.deployer.createSnapshot(projectConfig.path);
          } catch (error) {
            console.error(`[Agent] Snapshot error:`, error.message);
          }

          try {
            const deployResult = await this.deployer.deploy(
              projectConfig.deployment,
              projectConfig.path
            );

            if (!deployResult.success) {
              console.log(`[Agent] Deploy failed: ${deployResult.error}`);
              this.sendProgress('error', 'Deploy fallito!', '❌');
              
              // Rollback
              if (snapshot) {
                this.sendProgress('deploy', 'Rollback in corso...', '🔄');
                try {
                  await this.deployer.restoreSnapshot(snapshot, projectConfig.path);
                  this.sendProgress('deploy', 'Rollback completato', '✅');
                } catch (rollbackError) {
                  this.sendProgress('error', `Rollback fallito: ${rollbackError.message}`, '❌');
                }
              }

              currentObjective = this.buildFixPrompt(currentObjective, [deployResult.error]);
              continue;
            }

            this.sendProgress('deploy', 'Deploy completato!', '✅');
            
            // Clean up snapshot on success
            if (snapshot) {
              await this.deployer.deleteSnapshot(snapshot);
            }

            // Wait for deployment to stabilize
            await this.delay(3000);

          } catch (error) {
            console.error(`[Agent] Deploy error:`, error.message);
            this.sendProgress('error', `Errore deploy: ${error.message}`, '❌');
            
            if (snapshot) {
              await this.deployer.restoreSnapshot(snapshot, projectConfig.path);
            }
            
            currentObjective = this.buildFixPrompt(currentObjective, [error.message]);
            continue;
          }
        }

        // ============ STEP 4: TEST ============
        if (projectConfig.testing?.enabled) {
          this.sendProgress('test', 'Esecuzione test...', '🧪');
          
          try {
            const testResult = await this.tester.runTests(projectConfig);
            
            if (!testResult.success) {
              console.log(`[Agent] Tests failed: ${testResult.failed.join(', ')}`);
              this.sendProgress('error', `Test falliti: ${testResult.failed.join(', ')}`, '❌');
              
              currentObjective = this.buildFixPrompt(currentObjective, testResult.errors);
              continue;
            }

            this.sendProgress('test', `Test passati: ${testResult.passed.join(', ')}`, '✅');
            
          } catch (error) {
            console.error(`[Agent] Test error:`, error.message);
            this.sendProgress('warning', `Errore test: ${error.message}`, '⚠️');
            // Non-blocking for test errors
          }
        }

        // ============ STEP 5: VERIFY OBJECTIVE ============
        this.sendProgress('review', 'Verifica obiettivo...', '🔍');
        
        try {
          const verifyResult = await this.claude.verifyObjective(
            objective, // Original objective
            conversationHistory,
            projectConfig
          );

          console.log(`[Agent] Verify: ${verifyResult.recommendation}, confidence: ${verifyResult.confidence}%`);

          if (verifyResult.objectiveReached && verifyResult.confidence >= 80) {
            // SUCCESS!
            this.sendProgress('ready', 'Obiettivo raggiunto!', '🎉');
            
            this.sendReadyNotification({
              iterations: iteration,
              filesChanged: devResult.filesChanged,
              deployUrl: projectConfig.deployment?.url,
              summary: verifyResult
            });

            result = {
              success: true,
              iterations: iteration,
              filesChanged: devResult.filesChanged,
              deployUrl: projectConfig.deployment?.url
            };
            break;

          } else if (verifyResult.recommendation === 'CONTINUE') {
            // Need more work
            if (verifyResult.remainingTasks.length > 0) {
              currentObjective = this.buildNextIterationPrompt(
                objective,
                verifyResult.remainingTasks
              );
            }
          } else {
            // Review needed or issues
            if (verifyResult.issues.length > 0) {
              currentObjective = this.buildFixPrompt(objective, verifyResult.issues);
            }
          }

        } catch (error) {
          console.error(`[Agent] Verify error:`, error.message);
          // Continue anyway
        }
      }

      // Max iterations reached
      if (!result.success) {
        result = { success: false, reason: 'MAX_ITERATIONS' };
        this.sendProgress('warning', 'Limite iterazioni raggiunto', '⚠️');
      }

    } catch (error) {
      console.error(`[Agent] Fatal error:`, error);
      result = { success: false, reason: 'ERROR', error: error.message };
      this.sendProgress('error', `Errore fatale: ${error.message}`, '❌');
    } finally {
      this.isRunning = false;
      this.currentProjectId = null;
      await this.tester.cleanup();
    }

    return result;
  }

  /**
   * Stop the agent
   */
  stop() {
    console.log(`[Agent] Stop requested`);
    this.shouldStop = true;
  }

  /**
   * Request authorization from user
   */
  async requestAuthorization(plannedChanges, autonomyLevel) {
    const requestId = `auth-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Prepare changes for display
    const changes = plannedChanges.map(change => ({
      path: change.path,
      action: change.action,
      lines: change.content ? this.countLines(change.content) : 0,
      diff: change.action === 'modify' ? this.generateSimpleDiff(change) : null
    }));

    // Send request to client
    this.sendMessage({
      type: 'REQUEST_AUTH',
      requestId,
      autonomyLevel,
      files: changes,
      timestamp: new Date().toISOString()
    });

    // Wait for response
    return new Promise((resolve) => {
      const timeout = this.config.defaultTimeout || 300000; // 5 min
      
      // Store resolver
      this.pendingAuthorizations.set(requestId, {
        resolve,
        timeout: setTimeout(() => {
          this.pendingAuthorizations.delete(requestId);
          resolve({ approved: false, feedback: 'Authorization timeout' });
        }, timeout)
      });
    });
  }

  /**
   * Handle authorization response from client
   */
  handleAuthorizationResponse(requestId, approved, approvedFiles, feedback) {
    const pending = this.pendingAuthorizations.get(requestId);
    
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingAuthorizations.delete(requestId);
      pending.resolve({ approved, approvedFiles, feedback });
    }
  }

  /**
   * Send progress update to WebSocket client
   */
  sendProgress(stage, message, emoji = '🔄') {
    this.sendMessage({
      type: 'PROGRESS',
      stage,
      message,
      emoji,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send ready notification
   */
  sendReadyNotification(summary) {
    this.sendMessage({
      type: 'READY_FOR_HUMAN',
      summary,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send message to WebSocket client
   */
  sendMessage(message) {
    if (this.wsClient && this.wsClient.readyState === 1) {
      try {
        this.wsClient.send(JSON.stringify(message));
      } catch (error) {
        console.error(`[Agent] WebSocket send error:`, error.message);
      }
    }
  }

  /**
   * Get content of specified files
   */
  async getFilesContent(projectPath, files) {
    const contents = {};
    
    for (const file of files) {
      try {
        const fullPath = path.join(projectPath, file);
        const content = await fs.readFile(fullPath, 'utf-8');
        contents[file] = content;
      } catch (error) {
        console.error(`[Agent] Error reading ${file}:`, error.message);
      }
    }
    
    return contents;
  }

  /**
   * Build prompt for fixing issues
   */
  buildFixPrompt(originalObjective, issues) {
    const issuesList = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
    
    return `ORIGINAL OBJECTIVE: ${originalObjective}

ISSUES TO FIX:
${issuesList}

Please fix these issues and continue working toward the original objective.`;
  }

  /**
   * Build prompt for revision based on user feedback
   */
  buildRevisionPrompt(originalObjective, feedback) {
    return `ORIGINAL OBJECTIVE: ${originalObjective}

USER FEEDBACK: ${feedback || 'Changes were rejected. Please try a different approach.'}

Please revise your approach based on this feedback and try again.`;
  }

  /**
   * Build prompt for next iteration
   */
  buildNextIterationPrompt(originalObjective, remainingTasks) {
    const tasksList = remainingTasks.map((task, i) => `${i + 1}. ${task}`).join('\n');
    
    return `ORIGINAL OBJECTIVE: ${originalObjective}

REMAINING TASKS:
${tasksList}

Continue working to complete these remaining items.`;
  }

  /**
   * Count lines in content
   */
  countLines(content) {
    return content.split('\n').length;
  }

  /**
   * Generate a simple diff preview
   */
  generateSimpleDiff(change) {
    if (!change.content) return null;
    
    const lines = change.content.split('\n');
    const preview = lines.slice(0, 10).join('\n');
    
    return {
      preview,
      totalLines: lines.length,
      truncated: lines.length > 10
    };
  }

  /**
   * Helper delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if agent is running
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      projectId: this.currentProjectId,
      pendingAuthorizations: this.pendingAuthorizations.size
    };
  }
}

export default AutonomousAgent;
