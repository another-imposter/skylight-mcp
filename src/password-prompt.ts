import { execFile } from 'node:child_process';

/**
 * Ask the person at the keyboard for the Skylight password in a native dialog,
 * instead of keeping it in the environment (`SKYLIGHT_PASSWORD_PROMPT=true`).
 *
 * The password goes from the dialog's stdout straight into `login()` and is
 * never stored, logged or returned to the model: a tool argument or a chat
 * message would put it in the transcript and the host's tool-call log, which
 * this server never allows for a credential (see config.ts on the Apple
 * password). The dialog only appears when the token cache has nothing usable,
 * so day-to-day tool calls never prompt.
 */

/** Runs a program and resolves its stdout. Injected by tests. */
export type RunProgram = (file: string, args: string[], opts: { timeout: number }) => Promise<string>;

export const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

export class PasswordPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPromptError';
  }
}

/* istanbul ignore next — thin wrapper over child_process; tests inject `run`. */
const defaultRun: RunProgram = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts.timeout, windowsHide: false, maxBuffer: 64 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });

/** PowerShell string literal: single quotes, with embedded quotes doubled. */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * A WinForms dialog with a masked text box. The password is written to stdout
 * base64-encoded (UTF-8) so no console code page can mangle it; Cancel or
 * closing the window exits 1 with nothing written.
 */
export function windowsScript(email: string): string {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$f = New-Object System.Windows.Forms.Form',
    "$f.Text = 'Skylight sign-in'",
    "$f.Size = New-Object System.Drawing.Size(380,170)",
    "$f.StartPosition = 'CenterScreen'",
    "$f.FormBorderStyle = 'FixedDialog'",
    '$f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.TopMost = $true',
    '$l = New-Object System.Windows.Forms.Label',
    `$l.Text = ${psQuote(`Skylight password for ${email}`)}`,
    '$l.AutoSize = $true; $l.Location = New-Object System.Drawing.Point(12,14)',
    '$t = New-Object System.Windows.Forms.TextBox',
    '$t.UseSystemPasswordChar = $true',
    '$t.Location = New-Object System.Drawing.Point(12,40); $t.Width = 340',
    '$ok = New-Object System.Windows.Forms.Button',
    "$ok.Text = 'Sign in'; $ok.DialogResult = 'OK'",
    '$ok.Location = New-Object System.Drawing.Point(196,80)',
    '$cancel = New-Object System.Windows.Forms.Button',
    "$cancel.Text = 'Cancel'; $cancel.DialogResult = 'Cancel'",
    '$cancel.Location = New-Object System.Drawing.Point(277,80)',
    '$f.Controls.AddRange(@($l,$t,$ok,$cancel))',
    '$f.AcceptButton = $ok; $f.CancelButton = $cancel',
    '$f.Add_Shown({ $f.Activate(); $t.Focus() })',
    "if ($f.ShowDialog() -ne 'OK' -or $t.Text.Length -eq 0) { exit 1 }",
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t.Text)))',
  ].join('\n');
}

/** AppleScript string literal: double quotes, with backslashes and quotes escaped. */
function asQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function macScript(email: string): string {
  return (
    `set r to display dialog ${asQuote(`Skylight password for ${email}`)} ` +
    'default answer "" with hidden answer with title "Skylight sign-in" ' +
    'buttons {"Cancel", "Sign in"} default button "Sign in"\n' +
    'return text returned of r'
  );
}

export async function promptForPassword(
  email: string,
  opts: { platform?: NodeJS.Platform; run?: RunProgram } = {},
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  let stdout: string;
  try {
    if (platform === 'win32') {
      // -EncodedCommand takes UTF-16LE base64, which sidesteps every quoting
      // rule between Node, cmd and PowerShell. -STA is required by WinForms.
      const encoded = Buffer.from(windowsScript(email), 'utf16le').toString('base64');
      stdout = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        { timeout: PROMPT_TIMEOUT_MS },
      );
      stdout = Buffer.from(stdout.trim(), 'base64').toString('utf8');
    } else if (platform === 'darwin') {
      stdout = (await run('osascript', ['-e', macScript(email)], { timeout: PROMPT_TIMEOUT_MS })).replace(/\r?\n$/, '');
    } else {
      throw new PasswordPromptError(
        `SKYLIGHT_PASSWORD_PROMPT is only supported on Windows and macOS (this is ${platform}). ` +
          'Set SKYLIGHT_PASSWORD or SKYLIGHT_REFRESH_TOKEN instead.',
      );
    }
  } catch (err) {
    if (err instanceof PasswordPromptError) throw err;
    // Never echo the child's output: on some failures it could hold what was typed.
    throw new PasswordPromptError(
      'The Skylight password prompt was cancelled, timed out or could not open. ' +
        'Call the tool again to get a new prompt.',
    );
  }
  if (!stdout) {
    throw new PasswordPromptError('No password was entered in the Skylight sign-in prompt. Call the tool again to retry.');
  }
  return stdout;
}
