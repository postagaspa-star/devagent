import puppeteer from 'puppeteer';
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

    // Run Puppeteer tests
    if (testing.puppeteer && projectConfig.deployment?.url) {
      console.log(`[Tester] Running Puppeteer tests on ${projectConfig.deployment.url}`);
      
      const puppeteerResult = await this.runPuppeteerTests(
        projectConfig.deployment.url,
        testing.puppeteerConfig || {}
      );

      if (puppeteerResult.success) {
        results.passed.push('puppeteer-ui-test');
        console.log(`[Tester] Puppeteer tests passed`);
      } else {
        results.failed.push('puppeteer-ui-test');
        results.errors.push(...puppeteerResult.errors);
        results.success = false;
        console.log(`[Tester] Puppeteer tests failed`);
      }

      if (puppeteerResult.warnings.length > 0) {
        results.warnings.push(...puppeteerResult.warnings);
      }

      // Add screenshots if available
      if (puppeteerResult.screenshot) {
        results.screenshot = puppeteerResult.screenshot;
      }
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
   * Run Puppeteer UI tests
   */
  async runPuppeteerTests(url, config = {}) {
    const errors = [];
    const warnings = [];
    let screenshot = null;

    try {
      // Launch browser
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });

      const page = await this.browser.newPage();

      // Set viewport
      await page.setViewport({
        width: config.width || 1280,
        height: config.height || 800
      });

      // Collect console errors
      page.on('console', msg => {
        const text = msg.text();
        const type = msg.type();
        
        if (type === 'error') {
          errors.push(`Console Error: ${text}`);
        } else if (type === 'warning' || text.includes('Warning')) {
          warnings.push(`Console Warning: ${text}`);
        }
      });

      // Collect page errors
      page.on('pageerror', error => {
        errors.push(`Page Error: ${error.message}`);
      });

      // Collect request failures
      page.on('requestfailed', request => {
        const url = request.url();
        const failure = request.failure();
        
        // Ignore analytics/tracking failures
        if (!url.includes('analytics') && !url.includes('tracking')) {
          errors.push(`Request Failed: ${url} - ${failure?.errorText || 'Unknown'}`);
        }
      });

      // Navigate to URL
      console.log(`[Tester] Navigating to ${url}`);
      
      const response = await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: config.timeout || 30000
      });

      // Check HTTP status
      if (!response.ok()) {
        errors.push(`HTTP Error: ${response.status()} ${response.statusText()}`);
      }

      // Wait for page to stabilize
      await this.delay(config.stabilizeDelay || 2000);

      // Take screenshot
      if (config.screenshot !== false) {
        screenshot = await page.screenshot({
          encoding: 'base64',
          fullPage: false
        });
      }

      // Run custom checks if configured
      if (config.checks) {
        for (const check of config.checks) {
          const checkResult = await this.runCustomCheck(page, check);
          if (!checkResult.success) {
            errors.push(checkResult.error);
          }
        }
      }

      // Basic accessibility check
      if (config.accessibilityCheck !== false) {
        const accessibilityIssues = await this.basicAccessibilityCheck(page);
        warnings.push(...accessibilityIssues);
      }

      await this.browser.close();
      this.browser = null;

      return {
        success: errors.length === 0,
        errors,
        warnings,
        screenshot
      };

    } catch (error) {
      // Clean up on error
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.browser = null;
      }

      return {
        success: false,
        errors: [error.message],
        warnings,
        screenshot: null
      };
    }
  }

  /**
   * Run a custom Puppeteer check
   */
  async runCustomCheck(page, check) {
    try {
      switch (check.type) {
        case 'selector_exists':
          const element = await page.$(check.selector);
          if (!element) {
            return { success: false, error: `Element not found: ${check.selector}` };
          }
          break;

        case 'text_contains':
          const content = await page.content();
          if (!content.includes(check.text)) {
            return { success: false, error: `Text not found: ${check.text}` };
          }
          break;

        case 'no_broken_images':
          const brokenImages = await page.evaluate(() => {
            return Array.from(document.images)
              .filter(img => !img.complete || img.naturalWidth === 0)
              .map(img => img.src);
          });
          if (brokenImages.length > 0) {
            return { success: false, error: `Broken images: ${brokenImages.join(', ')}` };
          }
          break;

        default:
          return { success: true };
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Basic accessibility check
   */
  async basicAccessibilityCheck(page) {
    const issues = [];

    try {
      const results = await page.evaluate(() => {
        const problems = [];

        // Check for images without alt text
        document.querySelectorAll('img:not([alt])').forEach(img => {
          problems.push(`Image without alt text: ${img.src.substring(0, 50)}`);
        });

        // Check for missing form labels
        document.querySelectorAll('input:not([type="hidden"]):not([aria-label]):not([id])').forEach(() => {
          problems.push('Form input without label');
        });

        // Check for empty links
        document.querySelectorAll('a:not([aria-label])').forEach(a => {
          if (!a.textContent.trim() && !a.querySelector('img')) {
            problems.push('Empty link without text or image');
          }
        });

        // Check for missing document language
        if (!document.documentElement.lang) {
          problems.push('Missing document language');
        }

        return problems;
      });

      issues.push(...results);
    } catch (error) {
      // Ignore evaluation errors
    }

    return issues;
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
