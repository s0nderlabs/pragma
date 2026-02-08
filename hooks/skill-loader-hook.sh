#!/usr/bin/env bash
# UserPromptSubmit Hook — Pragma Skill Loader
# Ensures pragma-core and autonomous-mode skills are active for trading operations.
# Outputs a system reminder that Claude sees on every prompt.

echo "If pragma-core and autonomous-mode skills have not been loaded yet in this session, load them now using the Skill tool before responding to any trading, wallet, agent, or market-related request."
