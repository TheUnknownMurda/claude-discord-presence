'use strict';

/**
 * Ready-made presence looks, selected with `"theme": "<name>"` in config.json
 * (or `claude-presence theme <name>`).
 *
 * A theme is just a partial config that is merged BETWEEN the defaults and the
 * user's own file — so it changes whatever you haven't set yourself, and any
 * key you do set in config.json always wins. Text fields may use the
 * `{placeholders}` documented in presence-builder.js.
 */

const THEMES = {
  // The stock look: rotating chit-chat lines, plan + usage in the tooltip.
  default: {},

  // One quiet line, no rotation, no buttons. Good if you find RPC noisy.
  minimal: {
    presence: {
      details: 'Claude',
      stateActive: '{model}',
      stateIdle: 'Idle',
      rotateMessages: [],
      buttons: [],
    },
  },

  // For Claude Code: the project you're in, how many prompts deep, and the
  // session's size in tokens. {title} is available too if you'd rather show
  // the session's name: details: '{title}'.
  coder: {
    presence: {
      details: 'Building {project}',
      detailsIdle: 'Taking a break from {project}',
      stateActive: '{model} · {messages:prompt|prompts} · {tokens} tokens',
      stateIdle: '{model} · idle',
      rotateMessages: [],
      smallTextActive: '{branch}',
    },
    project: { show: true },
  },

  // Leans on the numbers: locally-measured time plus the plan's real meters.
  stats: {
    presence: {
      details: 'Claude · {today} today · 5h {usage5h}',
      stateActive: '{model} · {streak:day|days} streak',
      stateIdle: '{plan} · {month} this month · week {usage7d}',
      rotateMessages: [],
    },
    usage: { show: true, showToday: true, showMonth: true, showLimits: true },
  },

  // Playful rotating lines, no numbers.
  chill: {
    presence: {
      stateActive: '{model}',
      stateIdle: 'Away from the keyboard',
      rotateMessages: [
        'Thinking out loud with Claude',
        'Rubber-ducking with Claude',
        'Asking the big questions',
        'Untangling something',
      ],
      rotateIntervalSeconds: 45,
    },
  },
};

/** Sorted list of valid theme names. */
function names() {
  return Object.keys(THEMES).sort();
}

/** The partial config for `name`, or null when the name is unknown. */
function get(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || !Object.prototype.hasOwnProperty.call(THEMES, key)) return null;
  return JSON.parse(JSON.stringify(THEMES[key]));
}

module.exports = { THEMES, names, get };
