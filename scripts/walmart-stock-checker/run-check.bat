@echo off
cd /d %~dp0
if not exist logs mkdir logs
node check-stock.js >> logs\task-run.log 2>&1
