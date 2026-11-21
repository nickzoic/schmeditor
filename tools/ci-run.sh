#!/usr/bin/env bash
# Run a command in CI, and if it fails leave the end of its output in an annotation.
#
#   bash tools/ci-run.sh "name for the annotation" command [args...]
#
# The command's output goes through as usual and its exit status is kept. When it fails, the last
# lines of its output are also written as a GitHub Actions error annotation. Annotations show on the
# run's page and come back from the check-runs API, which is how a failure can be read without
# downloading the log (job logs are served from a separate storage host that is not always reachable).
#
#   CI_RUN_LINES   how many lines to keep (default 80)
#
# Written to work with the bash on Linux, macOS and Windows (Git Bash): only POSIX awk, tail and head.
title=$1
shift
lines=${CI_RUN_LINES:-80}
log=$(mktemp)
trap 'rm -f "$log" "$log.msg"' EXIT

"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
  {
    echo "exit status $status: $*"
    tail -n "$lines" "$log" | tail -c 24000      # the end is what matters: keep it if the lines are very long
  } | awk '
    # Drop colour codes and carriage returns, then escape for a workflow command: % first, and a
    # line break becomes %0A (the lines are joined below).
    {
      gsub(/\033\[[0-9;]*[A-Za-z]/, "")
      gsub(/\r/, "")
      gsub(/%/, "%25")
      line[NR] = $0
    }
    END { for (i = 1; i <= NR; i++) printf "%s%s", line[i], (i < NR ? "%0A" : ""); printf "\n" }
  ' > "$log.msg"
  safe_title=$(printf '%s' "$title" | awk '{ gsub(/%/, "%25"); gsub(/:/, "%3A"); gsub(/,/, "%2C"); print }')
  # GitHub accepts up to 64 KB in an annotation; the cap keeps the end of the message, not the start.
  printf '::error title=%s::%s\n' "$safe_title" "$(tail -c 60000 "$log.msg")"
fi
exit "$status"
