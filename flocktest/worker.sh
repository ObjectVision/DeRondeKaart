#!/usr/bin/env bash
# Simulates the coalescing guard: RUN lock = build in progress, PENDING = one queued slot.
RUN=/tmp/flocktest/run.lock
PEND=/tmp/flocktest/pend.lock
LOG=/tmp/flocktest/out.log
id="$1"
(
  flock -n 9 || { echo "[$id] a build is queued already -> DROP" >> $LOG; exit 0; }
  exec 8>$RUN
  flock 8                     # wait for the running build to finish
  echo "[$id] START build" >> $LOG
  sleep 2                     # the "build"
  echo "[$id] DONE build" >> $LOG
) 9>$PEND
