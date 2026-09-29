import type { PolicyDecision, RiskLevel, ToolMetadata, UserSettings } from '@assistant/schemas';

/**
 * The policy engine.
 *
 * The model proposes a tool call; it never decides whether that call may run.
 * This function is the only thing that decides, it is deterministic, and it
 * reads nothing the model produced — only the tool's declared metadata and the
 * user's settings. No prompt, however phrased, can move it.
 *
 * Keeping it a pure function matters: it can be tested exhaustively, and a
 * refactor that forgets to call it fails closed at `executeCall` rather than
 * quietly gaining the ability to empty someone's Trash.
 */

export interface PolicyContext {
  settings: UserSettings;
  /** Network reachability. Tools needing it are denied rather than left to hang. */
  online: boolean;
}

/** Escalating; used only to compare, never to skip a level. */
const ORDER: Record<RiskLevel, number> = {
  read: 0,
  reversible: 1,
  external: 2,
  destructive: 3,
  critical: 4,
};

const WHY: Record<RiskLevel, string> = {
  read: 'reads information without changing anything',
  reversible: 'changes something that can be undone',
  external: 'reaches someone or something outside this machine, and cannot be taken back',
  destructive: 'removes or exposes data',
  critical: 'touches money, credentials or security settings',
};

export function decide(metadata: ToolMetadata, ctx: PolicyContext): PolicyDecision {
  const { name, risk, requiresNetwork } = metadata;
  const { settings, online } = ctx;

  /**
   * Platform authentication is demanded by the risk tier or by the user, and
   * the user can only ever add to it. There is no setting that turns Touch ID
   * off for a `critical` tool, because that is the tier's whole meaning.
   */
  const strength = (): 'normal' | 'strong' =>
    ORDER[risk] >= ORDER.critical || settings.strongAuthTools.includes(name) ? 'strong' : 'normal';

  // Denials come first: no point confirming something that cannot run.
  if (requiresNetwork && !online) {
    return { action: 'deny', reason: `"${name}" needs the network, which is unavailable.` };
  }

  // The user's explicit "always ask" wins over every relaxation below.
  if (settings.alwaysConfirmTools.includes(name)) {
    return {
      action: 'confirm',
      strength: strength(),
      reason: `You asked to always confirm "${name}".`,
    };
  }

  switch (risk) {
    case 'read':
      // A tool the user has pinned to Touch ID is confirmed even here: they
      // asked for a gate, and "it only reads" is our judgement, not theirs.
      return settings.strongAuthTools.includes(name)
        ? { action: 'confirm', strength: 'strong', reason: `You asked to authenticate "${name}".` }
        : { action: 'allow' };

    case 'reversible':
      // Undoable by definition, so the default is to just do it. The risk
      // table calls this preference-controlled; the preferences that exist are
      // `alwaysConfirmTools`, handled above, and `strongAuthTools`.
      return settings.strongAuthTools.includes(name)
        ? { action: 'confirm', strength: 'strong', reason: `You asked to authenticate "${name}".` }
        : { action: 'allow' };

    case 'external':
      // Pre-approval is honoured here — "always let Assistant message Rahul" is a
      // reasonable thing to want — but never below.
      return settings.autoApprovedTools.includes(name) && strength() === 'normal'
        ? { action: 'allow' }
        : { action: 'confirm', strength: strength(), reason: `"${name}" ${WHY[risk]}.` };

    case 'destructive':
      // Deliberately ignores autoApprovedTools. A blanket "yes" collected once
      // must not authorise deleting things later.
      return { action: 'confirm', strength: strength(), reason: `"${name}" ${WHY[risk]}.` };

    case 'critical':
      return { action: 'confirm', strength: 'strong', reason: `"${name}" ${WHY[risk]}.` };
  }
}

/** Convenience for callers that only need to know whether to prompt. */
export function requiresConfirmation(metadata: ToolMetadata, ctx: PolicyContext): boolean {
  return decide(metadata, ctx).action === 'confirm';
}
