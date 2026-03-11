import { exec, execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Deployer class with snapshot and rollback support
 */
export class Deployer {
  constructor() {
    this.snapshotDir = '/tmp/devagent-snapshots';
    this.initSnapshotDir();
  }

  /**
   * Initialize snapshot directory
   */
  async initSnapshotDir() {
    try {
      await fs.mkdir(this.snapshotDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create snapshot directory:', error);
    }
  }

  /**
   * Deploy project using configured command
   */
  async deploy(deploymentConfig, projectPath) {
    if (!deploymentConfig.enabled) {
      return { success: true, skipped: true, message: 'Deployment disabled' };
    }

    if (!deploymentConfig.command) {
      return { success: false, error: 'No deployment command configured' };
    }

    console.log(`[Deployer] Starting deployment for ${projectPath}`);
    console.log(`[Deployer] Command: ${deploymentConfig.command}`);

    try {
      // Sanitize command - basic protection
      const sanitizedCommand = this.sanitizeCommand(deploymentConfig.command);
      
      const { stdout, stderr } = await execAsync(sanitizedCommand, {
        cwd: projectPath,
        timeout: 300000, // 5 min max
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });

      console.log(`[Deployer] Deployment successful`);
      
      return {
        success: true,
        output: stdout,
        warnings: stderr || undefined,
        url: deploymentConfig.url
      };
    } catch (error) {
      console.error(`[Deployer] Deployment failed:`, error.message);
      
      return {
        success: false,
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr
      };
    }
  }

  /**
   * Create a snapshot of the project for rollback
   */
  async createSnapshot(projectPath) {
    const snapshotId = `snapshot-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const snapshotPath = path.join(this.snapshotDir, snapshotId);

    console.log(`[Deployer] Creating snapshot: ${snapshotId}`);

    try {
      // Copy project files, excluding node_modules and .git
      await this.copyDirectory(projectPath, snapshotPath, {
        exclude: ['node_modules', '.git', '.env', 'dist', 'build', '.next']
      });

      // Get file count for verification
      const files = await this.countFiles(snapshotPath);

      console.log(`[Deployer] Snapshot created: ${files} files`);

      return {
        id: snapshotId,
        path: snapshotPath,
        timestamp: Date.now(),
        fileCount: files
      };
    } catch (error) {
      console.error(`[Deployer] Snapshot failed:`, error.message);
      throw error;
    }
  }

  /**
   * Restore project from snapshot
   */
  async restoreSnapshot(snapshot, projectPath) {
    console.log(`[Deployer] Restoring snapshot: ${snapshot.id}`);

    try {
      // Verify snapshot exists
      await fs.access(snapshot.path);

      // Get list of files to restore
      const snapshotFiles = await this.listFilesRecursive(snapshot.path);
      
      // Restore each file
      for (const file of snapshotFiles) {
        const relativePath = path.relative(snapshot.path, file);
        const targetPath = path.join(projectPath, relativePath);
        
        // Create parent directory if needed
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        
        // Copy file
        await fs.copyFile(file, targetPath);
      }

      console.log(`[Deployer] Snapshot restored: ${snapshotFiles.length} files`);

      // Clean up snapshot
      await this.deleteSnapshot(snapshot);

      return { success: true, filesRestored: snapshotFiles.length };
    } catch (error) {
      console.error(`[Deployer] Restore failed:`, error.message);
      throw error;
    }
  }

  /**
   * Delete a snapshot
   */
  async deleteSnapshot(snapshot) {
    try {
      await fs.rm(snapshot.path, { recursive: true, force: true });
      console.log(`[Deployer] Snapshot deleted: ${snapshot.id}`);
    } catch (error) {
      console.error(`[Deployer] Failed to delete snapshot:`, error.message);
    }
  }

  /**
   * Clean up old snapshots (older than 1 hour)
   */
  async cleanupOldSnapshots() {
    const maxAge = 60 * 60 * 1000; // 1 hour
    const now = Date.now();

    try {
      const entries = await fs.readdir(this.snapshotDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('snapshot-')) {
          const snapshotPath = path.join(this.snapshotDir, entry.name);
          const stat = await fs.stat(snapshotPath);
          
          if (now - stat.mtimeMs > maxAge) {
            await fs.rm(snapshotPath, { recursive: true, force: true });
            console.log(`[Deployer] Cleaned up old snapshot: ${entry.name}`);
          }
        }
      }
    } catch (error) {
      console.error(`[Deployer] Cleanup failed:`, error.message);
    }
  }

  /**
   * Copy directory with exclusions
   */
  async copyDirectory(src, dest, options = {}) {
    const exclude = options.exclude || [];
    
    await fs.mkdir(dest, { recursive: true });
    
    const entries = await fs.readdir(src, { withFileTypes: true });
    
    for (const entry of entries) {
      if (exclude.includes(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath, options);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Count files in directory
   */
  async countFiles(dir) {
    let count = 0;
    
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await this.countFiles(path.join(dir, entry.name));
      } else {
        count++;
      }
    }
    
    return count;
  }

  /**
   * List all files recursively
   */
  async listFilesRecursive(dir) {
    const files = [];
    
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        files.push(...await this.listFilesRecursive(fullPath));
      } else {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  /**
   * Sanitize shell command (basic protection)
   */
  sanitizeCommand(command) {
    // Remove potentially dangerous patterns
    const dangerous = [
      /;\s*rm\s+-rf/gi,
      /;\s*sudo/gi,
      /\|\s*sh/gi,
      /\|\s*bash/gi,
      /`[^`]*`/gi, // Command substitution
      /\$\([^)]*\)/gi, // Command substitution
    ];
    
    let sanitized = command;
    
    for (const pattern of dangerous) {
      if (pattern.test(sanitized)) {
        throw new Error('Potentially dangerous command pattern detected');
      }
    }
    
    return sanitized;
  }

  /**
   * Check if a URL is accessible
   */
  async checkUrl(url, timeout = 30000) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      return {
        success: response.ok,
        status: response.status,
        statusText: response.statusText
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export default Deployer;
