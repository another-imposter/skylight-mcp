import { describe, it, expect, vi } from 'vitest';
import {
  promptForPassword,
  windowsScript,
  macScript,
  PasswordPromptError,
  PROMPT_TIMEOUT_MS,
} from '../src/password-prompt.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('promptForPassword', () => {
  it('runs a hidden-window PowerShell dialog on Windows and decodes the base64 password', async () => {
    const run = vi.fn().mockResolvedValue(`${b64('pä$$ w0rd')}\r\n`);
    await expect(promptForPassword('a@b.com', { platform: 'win32', run })).resolves.toBe('pä$$ w0rd');

    const [file, args, opts] = run.mock.calls[0]!;
    expect(file).toBe('powershell.exe');
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-STA', '-EncodedCommand']));
    expect(opts).toEqual({ timeout: PROMPT_TIMEOUT_MS });
    // The script travels UTF-16LE base64-encoded, so no quoting can break it.
    const script = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    expect(script).toBe(windowsScript('a@b.com'));
  });

  it('uses a hidden-answer osascript dialog on macOS', async () => {
    const run = vi.fn().mockResolvedValue('secret\n');
    await expect(promptForPassword('a@b.com', { platform: 'darwin', run })).resolves.toBe('secret');
    expect(run).toHaveBeenCalledWith('osascript', ['-e', macScript('a@b.com')], { timeout: PROMPT_TIMEOUT_MS });
  });

  it('refuses other platforms without running anything', async () => {
    const run = vi.fn();
    await expect(promptForPassword('a@b.com', { platform: 'linux', run })).rejects.toThrow(/only supported on Windows and macOS/);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a cancelled or failed dialog without echoing its output', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('Command failed: typed-secret'), { code: 1 }));
    const err = await promptForPassword('a@b.com', { platform: 'win32', run }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasswordPromptError);
    expect((err as Error).message).toMatch(/cancelled, timed out or could not open/);
    expect((err as Error).message).not.toContain('typed-secret');
  });

  it('treats an empty answer as no password', async () => {
    const run = vi.fn().mockResolvedValue('\n');
    await expect(promptForPassword('a@b.com', { platform: 'darwin', run })).rejects.toThrow(/No password was entered/);
  });

  it('needs no runner to refuse an unsupported platform', async () => {
    await expect(promptForPassword('a@b.com', { platform: 'linux' })).rejects.toBeInstanceOf(PasswordPromptError);
  });

  it('defaults to the current platform', async () => {
    const run = vi.fn().mockResolvedValue(process.platform === 'win32' ? b64('x') : 'x');
    const p = promptForPassword('a@b.com', { run });
    if (process.platform === 'win32' || process.platform === 'darwin') await expect(p).resolves.toBe('x');
    else await expect(p).rejects.toBeInstanceOf(PasswordPromptError);
  });
});

describe('dialog scripts', () => {
  it('quotes the email safely for PowerShell', () => {
    expect(windowsScript("o'brien@x.com")).toContain("'Skylight password for o''brien@x.com'");
  });

  it('masks the PowerShell text box and writes only base64 to stdout', () => {
    const s = windowsScript('a@b.com');
    expect(s).toContain('UseSystemPasswordChar = $true');
    expect(s).toContain('ToBase64String');
  });

  it('quotes the email safely for AppleScript', () => {
    expect(macScript('a"b\\c@x.com')).toContain('"Skylight password for a\\"b\\\\c@x.com"');
    expect(macScript('a@b.com')).toContain('with hidden answer');
  });
});
