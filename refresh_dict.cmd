@echo off
rem Regenerate the SBU + XBU Salesforce data dictionary and commit the result.
rem Read-only against both production orgs: sobject describes + Tooling queries.
rem Run by Windows Task Scheduler ("SF Data Dictionary Refresh") on the 1st of each month, 07:00.
rem
rem Commits, then pushes so Railway/Vercel redeploy from main. The commit is what
rem preserves the baseline; if the push fails (e.g. expired credential) the commit
rem stays local, the log says so, and the run exits 2 - push by hand.
setlocal
set R=%~dp0
set R=%R:~0,-1%
set LOG=%R%\refresh.log

echo. >> "%LOG%"
echo ==== start %DATE% %TIME% ==== >> "%LOG%"
cd /d "%R%" || exit /b 1

rem Pick up anything committed on GitHub since the last run (e.g. edits made on the
rem website) before this run changes files, so the push at the end fast-forwards.
git -C "%R%" pull --ff-only >> "%LOG%" 2>&1 || echo WARNING: git pull failed - the push at the end may be rejected >> "%LOG%"

rem Today, and the date of the previous run (from the changes file this run
rem is about to replace). Both read before anything is overwritten.
for /f %%d in ('node -e "console.log(new Date().toISOString().slice(0,10))"') do set TODAY=%%d
set PREV_DATE=
rem Relative path: we are already cd'd into %R%. A missing/unreadable file prints nothing,
rem which the check below turns into a clear FATAL.
for /f %%d in ('node -e "try{console.log(require('./changes.json').genDate)}catch(e){}"') do set PREV_DATE=%%d
if "%PREV_DATE%"=="" (
  echo FATAL: cannot determine previous run date from changes.json >> "%LOG%"
  goto :fail
)
echo previous run %PREV_DATE%, this run %TODAY% >> "%LOG%"

rem The scan overwrites the snapshot in place, so set the old one aside first.
if not exist "%R%\.prev" mkdir "%R%\.prev"
copy /y "%R%\sbu_data.json" "%R%\.prev\sbu_data.json" >nul || goto :fail
copy /y "%R%\xbu_data.json" "%R%\.prev\xbu_data.json" >nul || goto :fail

node scan_org2.js production sbu "%R%\sbu_data.json" "%R%\md_sbu"  >> "%LOG%" 2>&1 || goto :fail
node scan_org2.js xbu        xbu "%R%\xbu_data.json" "%R%\md"      >> "%LOG%" 2>&1 || goto :fail

rem Diff against the snapshot set aside above, then tag each added field with its
rem real CreatedDate so an FLS grant is not reported as a newly created field.
node diff_snapshot.js "%R%\.prev" %PREV_DATE%  >> "%LOG%" 2>&1 || goto :fail
node enrich_changes.js %PREV_DATE%             >> "%LOG%" 2>&1 || goto :fail

node pack.js %TODAY%       >> "%LOG%" 2>&1 || goto :fail
node build_dict_html3.js   >> "%LOG%" 2>&1 || goto :fail
node validate_merged.js    >> "%LOG%" 2>&1 || goto :fail

git -C "%R%" add -A                                 >> "%LOG%" 2>&1
git -C "%R%" commit -m "dictionary refresh %TODAY%" >> "%LOG%" 2>&1
git -C "%R%" push                                  >> "%LOG%" 2>&1 || goto :pushfail

echo ==== ok %DATE% %TIME% ==== >> "%LOG%"
exit /b 0

:pushfail
echo ==== COMMITTED BUT PUSH FAILED at %DATE% %TIME% - run git push by hand ==== >> "%LOG%"
exit /b 2

:fail
echo ==== FAILED errorlevel %errorlevel% at %DATE% %TIME% ==== >> "%LOG%"
exit /b 1
