export const defaultContent = `# Interactive Runbook Demo

Welcome to **Runotepad** - an interactive runbook that lets you execute shell commands directly from markdown.

## Getting Started

Try running the commands below by clicking the **Run** button.

### System Information

\`\`\`sh
uname -a
\`\`\`

### List Files

\`\`\`sh
ls -la
\`\`\`

### Current Directory

\`\`\`sh
pwd
\`\`\`

### Environment Variables

\`\`\`sh
env | head -10
\`\`\`

## Interactive Commands

You can also run interactive commands. The terminal below each code block supports input.

\`\`\`sh
echo "Hello from Runotepad!"
\`\`\`

## Notes

- Click the **Run** button next to any \`sh\` code block to execute it
- Output appears in an embedded terminal below the code block
- Each terminal session is interactive - you can type commands
- Close terminals with the X button when done
`;
