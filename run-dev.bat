@echo off
rem Starts FolderGram from source (needs Node.js 20+ from nodejs.org)
if not exist node_modules call npm install
call npm start
