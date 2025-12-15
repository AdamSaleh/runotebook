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

## Persistent Sessions

Use \`session=name\` to share a shell session across multiple code blocks. Changes in one block (like \`cd\`) persist when you run another block with the same session name.

### Example: Working Directory Session

First, create a temp directory and navigate to it:

\`\`\`sh session=workdir
mkdir -p /tmp/runotepad-demo && cd /tmp/runotepad-demo
echo "Current directory: $(pwd)"
\`\`\`

Now create a file (runs in the same session, so we're still in /tmp/runotepad-demo):

\`\`\`sh session=workdir
echo "Hello from Runotepad!" > greeting.txt
ls -la
\`\`\`

Read the file we just created:

\`\`\`sh session=workdir
cat greeting.txt
\`\`\`

### Another Session Example

You can have multiple named sessions. This one is separate from "workdir":

\`\`\`sh session=env
export MY_VAR="Hello World"
echo "Set MY_VAR to: $MY_VAR"
\`\`\`

The variable persists in this session:

\`\`\`sh session=env
echo "MY_VAR is still: $MY_VAR"
\`\`\`

## Standalone Commands

Code blocks without a session name get their own isolated terminal:

\`\`\`sh
echo "This is a standalone terminal"
pwd
\`\`\`

## Notes

- Click the **Run** button next to any \`sh\` code block to execute it
- Use \`session=name\` to share a persistent shell across blocks
- Output appears in an embedded terminal below the code block
- Each terminal session is interactive - you can type commands
- Close terminals with the X button when done
`;
