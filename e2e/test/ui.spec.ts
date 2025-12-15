import { test, expect, Page } from '@playwright/test';

test.describe('Runotepad UI Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for WebSocket connection
    await expect(page.locator('#statusText')).toHaveText('Connected', { timeout: 10000 });
  });

  test.describe('Page Structure', () => {
    test('should load with correct title', async ({ page }) => {
      await expect(page).toHaveTitle(/Runotepad/);
    });

    test('should have editor and preview panels', async ({ page }) => {
      await expect(page.locator('#editor')).toBeVisible();
      await expect(page.locator('#preview')).toBeVisible();
    });

    test('should have view tabs', async ({ page }) => {
      await expect(page.locator('[data-view="split"]')).toBeVisible();
      await expect(page.locator('[data-view="editor-only"]')).toBeVisible();
      await expect(page.locator('[data-view="preview-only"]')).toBeVisible();
    });

    test('should have connection status indicator', async ({ page }) => {
      await expect(page.locator('.connection-status')).toBeVisible();
      await expect(page.locator('.status-dot')).toBeVisible();
    });
  });

  test.describe('CodeMirror Editor', () => {
    test('should have CodeMirror initialized', async ({ page }) => {
      await expect(page.locator('.cm-editor')).toBeVisible();
      await expect(page.locator('.cm-content')).toBeVisible();
    });

    test('should contain default markdown content', async ({ page }) => {
      const editorContent = await page.locator('.cm-content').textContent();
      expect(editorContent).toContain('Interactive Runbook Demo');
    });

    test('should be editable', async ({ page }) => {
      const editor = page.locator('.cm-content');
      await editor.click();

      // Type some text
      await page.keyboard.type('# Test Heading');

      // Verify text appears in editor
      const content = await editor.textContent();
      expect(content).toContain('Test Heading');
    });

    test('should update preview when editor changes', async ({ page }) => {
      const editor = page.locator('.cm-content');
      await editor.click();

      // Clear and type new content
      await page.keyboard.press('Meta+a');
      await page.keyboard.type('# New Title\n\nSome paragraph text.');

      // Wait for preview update
      await page.waitForTimeout(500);

      // Check preview updated
      const preview = page.locator('#preview');
      await expect(preview.locator('h1')).toContainText('New Title');
      await expect(preview.locator('p')).toContainText('Some paragraph text');
    });
  });

  test.describe('Markdown Preview', () => {
    test('should render default content correctly', async ({ page }) => {
      const preview = page.locator('#preview');

      // Check heading is rendered
      await expect(preview.locator('h1').first()).toBeVisible();

      // Check code blocks are rendered
      await expect(preview.locator('.code-block-wrapper').first()).toBeVisible();
    });

    test('should have run buttons for sh code blocks', async ({ page }) => {
      const runButtons = page.locator('.run-btn');
      const count = await runButtons.count();
      expect(count).toBeGreaterThan(0);
    });

    test('run buttons should have correct attributes', async ({ page }) => {
      const firstRunBtn = page.locator('.run-btn').first();
      await expect(firstRunBtn).toHaveAttribute('data-block-id');
      await expect(firstRunBtn).toHaveAttribute('data-code');
    });
  });

  test.describe('Terminal/xterm.js', () => {
    test('should create terminal when run button is clicked', async ({ page }) => {
      // Click first run button
      await page.locator('.run-btn').first().click();

      // Wait for terminal to appear
      await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.xterm').first()).toBeVisible();
    });

    test('terminal should have fixed height and not grow infinitely', async ({ page }) => {
      // Click first run button
      await page.locator('.run-btn').first().click();

      // Wait for terminal
      await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });

      // Get initial terminal container height
      const termContainer = page.locator('.terminal-container').first();
      const initialBox = await termContainer.boundingBox();
      expect(initialBox).not.toBeNull();

      // Wait a bit for any resize events
      await page.waitForTimeout(2000);

      // Check height hasn't grown beyond max-height (400px + padding)
      const finalBox = await termContainer.boundingBox();
      expect(finalBox).not.toBeNull();
      expect(finalBox!.height).toBeLessThanOrEqual(420); // 400px max-height + some padding

      // Verify height didn't grow significantly
      expect(finalBox!.height).toBeLessThanOrEqual(initialBox!.height + 50);
    });

    test('terminal should have close button', async ({ page }) => {
      await page.locator('.run-btn').first().click();
      await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });

      await expect(page.locator('.terminal-close').first()).toBeVisible();
    });

    test('close button should remove terminal', async ({ page }) => {
      await page.locator('.run-btn').first().click();
      await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });

      // Click close
      await page.locator('.terminal-close').first().click();

      // Terminal should be removed
      await expect(page.locator('.terminal-wrapper')).toHaveCount(0, { timeout: 5000 });
    });

    test('terminal should receive output from command', async ({ page }) => {
      await page.locator('.run-btn').first().click();
      await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });

      // Wait for command output (the first code block should echo something)
      await page.waitForTimeout(2000);

      // Check terminal has content
      const terminalContent = await page.locator('.xterm-rows').first().textContent();
      expect(terminalContent).not.toBe('');
    });

    test('clicking run button again should send command to existing terminal', async ({ page }) => {
      const runBtn = page.locator('.run-btn').first();

      // First click creates terminal
      await runBtn.click();
      await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });

      // Wait for initial command
      await page.waitForTimeout(1000);

      // Second click should reuse terminal (still only 1 terminal)
      await runBtn.click();
      await page.waitForTimeout(500);

      const terminalCount = await page.locator('.terminal-wrapper').count();
      expect(terminalCount).toBe(1);
    });
  });

  test.describe('View Switching', () => {
    test('editor-only view should hide preview', async ({ page }) => {
      await page.locator('[data-view="editor-only"]').click();

      const container = page.locator('#container');
      await expect(container).toHaveClass(/editor-only/);
    });

    test('preview-only view should hide editor', async ({ page }) => {
      await page.locator('[data-view="preview-only"]').click();

      const container = page.locator('#container');
      await expect(container).toHaveClass(/preview-only/);
    });

    test('split view should show both panels', async ({ page }) => {
      // First switch to editor-only
      await page.locator('[data-view="editor-only"]').click();

      // Then back to split
      await page.locator('[data-view="split"]').click();

      const container = page.locator('#container');
      await expect(container).not.toHaveClass(/editor-only/);
      await expect(container).not.toHaveClass(/preview-only/);
    });
  });

  test.describe('WebSocket Connection', () => {
    test('should show connected status', async ({ page }) => {
      await expect(page.locator('#statusText')).toHaveText('Connected');
    });

    test('should show green status dot when connected', async ({ page }) => {
      const statusDot = page.locator('.status-dot');
      // Green color indicates connected
      await expect(statusDot).toHaveCSS('background-color', 'rgb(76, 175, 80)');
    });
  });

  test.describe('Multiple Terminals', () => {
    test('should support multiple terminals for different code blocks', async ({ page }) => {
      const runButtons = page.locator('.run-btn');
      const btnCount = await runButtons.count();

      if (btnCount >= 2) {
        // Click first two run buttons
        await runButtons.nth(0).click();
        await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });

        await runButtons.nth(1).click();
        await page.waitForTimeout(2000);

        // Should have 2 terminals
        const terminalCount = await page.locator('.terminal-wrapper').count();
        expect(terminalCount).toBe(2);
      }
    });
  });
});

test.describe('Visual Regression', () => {
  test('terminal size should remain stable', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#statusText')).toHaveText('Connected', { timeout: 10000 });

    // Click run button
    await page.locator('.run-btn').first().click();
    await expect(page.locator('.terminal-wrapper').first()).toBeVisible({ timeout: 10000 });

    // Take measurements over time
    const measurements: number[] = [];

    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(500);
      const box = await page.locator('.terminal-container').first().boundingBox();
      if (box) {
        measurements.push(box.height);
      }
    }

    // All measurements should be similar (within 10px)
    const maxHeight = Math.max(...measurements);
    const minHeight = Math.min(...measurements);
    expect(maxHeight - minHeight).toBeLessThan(10);
  });
});
