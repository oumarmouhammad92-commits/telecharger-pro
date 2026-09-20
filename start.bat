@echo off
rem ---------------------------------------------------------------
rem  Téléchargeur Pro - démarrage sous Windows (double-clic)
rem  Lance le moteur de téléchargement Python + l'interface Electron
rem ---------------------------------------------------------------
title Telechargeur Pro
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable.
  echo Installez-le depuis https://nodejs.org/ puis relancez ce fichier.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Premiere utilisation : installation des dependances...
  call npm install
  if errorlevel 1 (
    echo [ERREUR] L'installation des dependances a echoue.
    pause
    exit /b 1
  )
)

echo Demarrage du moteur Python et de l'interface...
node scripts\start.js
if errorlevel 1 pause
