import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Tester class for automated testing
 */
export class Tester {
  constructor() {
    this.browser = null;
  }

  /**
   * Run all configured tests for a project
   */
  async runTests(projectConfig) {
    const results = {
      success: true,
      passed: [],
      failed: [],
      errors: [],
      warnings: [],
      duration: 0
    };

    const startTime = Date.now();
    const testing = projectConfig.testing || {};

    console.log(`[Tester] Starting tests for ${projectConfig.name}`);

    // Run custom command tests
    if (testing.command) {
      const commandResult = await this.runCommandTest(testing.command, projectConfig.path);
      
      if (commandResult.success) {
        results.passed.push('custom-tests');
        console.log(`[Tester] Custom tests passed`);
      } else {
        results.failed.push('custom-tests');
        results.errors.push(commandResult.error);
        results.success = false;
        console.log(`[Tester] Custom tests failed: ${commandResult.error}`);
      }
    }

    // Run Puppeteer tests (skipped: puppeteer not installed)
    if (testing.puppeteer && projectConfig.deployment?.url) {
      console.log(`[Tester] Puppeteer tests skipped (puppeteer not available)`);
      results.warnings.push('Puppeteer tests skipped: puppeteer is not installed');
    }

    // Run lint check if configured
    if (testing.lint) {
      const lintResult = await this.runLintTest(testing.lintCommand || 'npm run lint', projectConfig.path);
      
      if (lintResult.success) {
        results.passed.push('lint');
      } else {
        results.warnings.push(...lintResult.errors);
        // Lint failures are warnings, not test failures
      }
    }

    results.duration = Date.now() - startTime;
    console.log(`[Tester] Tests completed in ${results.duration}ms`);

    return results;
  }

  /**
   * Run a custom test command
   */
  async runCommandTest(command, cwd) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 120000, // 2 min max
        maxBuffer: 5 * 1024 * 1024
      });

      return {
        success: true,
        output: stdout,
        warnings: stderr || undefined
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        output: error.stdout,
        stderr: error.stderr
      };
    }
  }

  /**
   * Run lint test
   */
  async runLintTest(command, cwd) {
    try {
      await execAsync(command, {
        cwd,
        timeout: 60000
      });

      return { success: true, errors: [] };
    } catch (error) {
      // Parse lint output for errors
      const errors = [];
      if (error.stdout) {
        const lines = error.stdout.split('\n').filter(l => l.trim());
        errors.push(...lines.slice(0, 10)); // First 10 errors
      }

      return { success: false, errors };
    }
  }

  /**
   * Run Puppeteer UI tests (stub: puppeteer not installed)
   */
  async runPuppeteerTests(url, config = {}) {
    return {
      success: false,
      errors: ['Puppeteer not installed'],
      warnings: [],
      screenshot: null
    };
  }

  /**
   * Helper delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

export default Tester;
