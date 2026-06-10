/* ============================================================
   Zamolxis desktop shell — vanilla JS, no build step.
   Window manager + taskbar + Start menu + apps.
   Apps ARE agents. Zamolxis is the default app and hosts the
   main chat. "Has a chat window" is a per-app setting.
   Talks to the existing backend: WS /?cid=..&token=.. and /api/*.
   ============================================================ */
(function () {
  'use strict';

  // ---------- icons ----------
  var ICON = {
    zamolxis: "<svg viewBox='0 0 32 32'><polygon points='16,2 29,9 29,23 16,30 3,23 3,9' fill='#b8893f'/><polygon points='16,2 29,9 29,23 16,30 3,23 3,9' fill='none' stroke='#e8c87a' stroke-width='1'/><text x='16' y='22' font-size='15' text-anchor='middle' fill='#1a150d' font-family='Segoe UI,Arial' font-weight='700'>Z</text></svg>",
    settings: "<svg viewBox='0 0 24 24' fill='none' stroke='#3a3a3a' stroke-width='1.6'><circle cx='12' cy='12' r='3.2'/><path d='M19.4 13a7.8 7.8 0 0 0 0-2l2-1.5-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6H9.1l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4L2.6 11a7.8 7.8 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4.9l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4z'/></svg>",
    agent: "<svg viewBox='0 0 24 24' fill='none' stroke='#2b6fd6' stroke-width='1.6'><rect x='4' y='8' width='16' height='12' rx='2.5'/><circle cx='9' cy='14' r='1.4' fill='#2b6fd6' stroke='none'/><circle cx='15' cy='14' r='1.4' fill='#2b6fd6' stroke='none'/><path d='M12 4v4M8 20v1.5M16 20v1.5'/></svg>",
    newagent: "<svg viewBox='0 0 24 24' fill='none' stroke='#2e9e3f' stroke-width='1.7'><circle cx='12' cy='12' r='9'/><path d='M12 8v8M8 12h8'/></svg>",
    help: "<svg viewBox='0 0 24 24' fill='none' stroke='#7a5cd0' stroke-width='1.7'><circle cx='12' cy='12' r='9'/><path d='M9.2 9.2a2.8 2.8 0 1 1 4 2.5c-.9.5-1.7 1-1.7 2.1'/><circle cx='11.6' cy='17' r='0.4' fill='#7a5cd0' stroke='none'/></svg>",
    files: "<svg viewBox='0 0 24 24' fill='#f5c542' stroke='#c9981f' stroke-width='1'><path d='M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h7A1.5 1.5 0 0 1 19 8.5v9A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z'/></svg>",
    editor: "<svg viewBox='0 0 24 24' fill='none' stroke='#3a7bd5' stroke-width='1.6'><rect x='4' y='3' width='16' height='18' rx='2'/><path d='M7.5 8h9M7.5 12h9M7.5 16h6'/></svg>",
    image: "<svg viewBox='0 0 24 24' fill='none' stroke='#2e9e6b' stroke-width='1.6'><rect x='3' y='5' width='18' height='14' rx='2'/><circle cx='8.5' cy='10' r='1.6' fill='#2e9e6b' stroke='none'/><path d='M21 16l-5-5-7 7' /></svg>",
    film: "<svg viewBox='0 0 24 24' fill='none' stroke='#c0508a' stroke-width='1.6'><rect x='3' y='4' width='18' height='16' rx='2'/><path d='M3 9h18M3 15h18M8 4v16M16 4v16'/></svg>",
    book: "<svg viewBox='0 0 24 24' fill='none' stroke='#a06a2c' stroke-width='1.6'><path d='M4 5.5A2 2 0 0 1 6 4h6v16H6a2 2 0 0 0-2 1.5z'/><path d='M20 5.5A2 2 0 0 0 18 4h-6v16h6a2 2 0 0 1 2 1.5z'/></svg>",
    pdf: "<svg viewBox='0 0 24 24' fill='none' stroke='#d3443b' stroke-width='1.6'><path d='M6 3h8l4 4v14H6z'/><path d='M14 3v4h4'/><text x='12' y='17' font-size='5.5' text-anchor='middle' fill='#d3443b' stroke='none' font-family='Arial' font-weight='700'>PDF</text></svg>",
    doc: "<svg viewBox='0 0 24 24' fill='none' stroke='#2b5797' stroke-width='1.6'><path d='M6 3h8l4 4v14H6z'/><path d='M14 3v4h4'/><path d='M9 12h6M9 15h6M9 9h3'/></svg>",
    sheet: "<svg viewBox='0 0 24 24' fill='none' stroke='#1f8a4c' stroke-width='1.6'><rect x='4' y='4' width='16' height='16' rx='1.5'/><path d='M4 10h16M4 15h16M10 4v16M15 4v16'/></svg>",
    calc: "<svg viewBox='0 0 24 24' fill='none' stroke='#555' stroke-width='1.6'><rect x='5' y='3' width='14' height='18' rx='2'/><rect x='7.5' y='5.5' width='9' height='3.5' rx='.6'/><path d='M8.5 13h0M12 13h0M15.5 13h0M8.5 16.5h0M12 16.5h0M15.5 16.5h0' stroke-linecap='round' stroke-width='2.2'/></svg>",
    term: "<svg viewBox='0 0 24 24' fill='none' stroke='#2c8f6f' stroke-width='1.6'><rect x='3' y='4' width='18' height='16' rx='2'/><path d='M7 9l3 3-3 3M12.5 15h4'/></svg>",
    net: "<svg viewBox='0 0 24 24' fill='none' stroke='#5566cc' stroke-width='1.6'><circle cx='12' cy='12' r='9'/><path d='M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18'/></svg>",
    chat: "<svg viewBox='0 0 24 24' fill='none' stroke='#0a8acb' stroke-width='1.6'><path d='M4 5h16v11H9l-4 3.5V16H4z'/><path d='M8 9h8M8 12h5'/></svg>",
    mail: "<svg viewBox='0 0 24 24' fill='none' stroke='#0a72c4' stroke-width='1.6'><rect x='3' y='5' width='18' height='14' rx='2'/><path d='M3.5 6.5l8.5 6 8.5-6'/></svg>",
    cal: "<svg viewBox='0 0 24 24' fill='none' stroke='#c0392b' stroke-width='1.6'><rect x='3' y='4.5' width='18' height='16' rx='2'/><path d='M3 9h18M8 3v3M16 3v3'/><rect x='6.5' y='12' width='3' height='3' rx='.4' fill='#c0392b' stroke='none'/></svg>",
    people: "<svg viewBox='0 0 24 24' fill='none' stroke='#7a5cd0' stroke-width='1.6'><circle cx='9' cy='8' r='3'/><path d='M3.5 19a5.5 5.5 0 0 1 11 0'/><path d='M16 6.5a3 3 0 0 1 0 5.8M17.5 19a5.5 5.5 0 0 0-3-4.9'/></svg>",
    notebook: "<svg viewBox='0 0 24 24' fill='none' stroke='#8e44ad' stroke-width='1.6'><rect x='5' y='3' width='14' height='18' rx='2'/><path d='M9 3v18M12 8h4M12 12h4'/></svg>",
    db: "<svg viewBox='0 0 24 24' fill='none' stroke='#2c7a4b' stroke-width='1.6'><ellipse cx='12' cy='5.5' rx='7' ry='2.5'/><path d='M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5'/></svg>",
    hist: "<svg viewBox='0 0 24 24' fill='none' stroke='#d18b1f' stroke-width='1.6'><path d='M3.5 12a8.5 8.5 0 1 1 2.6 6.1'/><path d='M3.5 18v-4h4'/><path d='M12 8v4l3 2'/></svg>"
  };

  // Per-agent app icon: a colored rounded tile with the agent's initial (deterministic from the name).
  function hashHue(s) { var h = 0; for (var i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }
  function agentIconSvg(name) {
    var ch = ((name || '?').trim().charAt(0) || '?').toUpperCase();
    var hue = hashHue(name || 'a'), hue2 = (hue + 40) % 360, gid = 'ag' + hue + '_' + ch.charCodeAt(0);
    return "<svg viewBox='0 0 24 24'><defs><linearGradient id='" + gid + "' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='hsl(" + hue + ",68%,56%)'/><stop offset='1' stop-color='hsl(" + hue2 + ",68%,44%)'/></linearGradient></defs>" +
      "<rect x='2' y='2' width='20' height='20' rx='5.5' fill='url(#" + gid + ")'/>" +
      "<text x='12' y='16.5' font-size='12' font-weight='700' text-anchor='middle' fill='#fff' font-family='Segoe UI,Arial'>" + ch + "</text></svg>";
  }

  // ---------- helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function api(path, opts) { return fetch(path, opts).then(function (r) { return r.json(); }); }
  function uuid() { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c' + Date.now() + Math.random().toString(16).slice(2); }
  var AGENT_NAME = (document.title || 'Zamolxis').trim() || 'Zamolxis';

  // ---------- OS theme ----------
  function detectOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (p.indexOf('mac') !== -1 || p.indexOf('iphone') !== -1 || p.indexOf('ipad') !== -1) return 'mac';
    if (p.indexOf('linux') !== -1 || p.indexOf('ubuntu') !== -1 || p.indexOf('x11') !== -1) return 'ubuntu';
    return 'win';
  }
  function themeChoice() { return localStorage.getItem('zx_os') || 'auto'; }
  function applyTheme() {
    var choice = themeChoice();
    var eff = choice === 'auto' ? detectOS() : choice;
    document.body.dataset.os = eff;
    return { choice: choice, effective: eff };
  }
  function setTheme(choice) { localStorage.setItem('zx_os', choice); applyTheme(); try { Object.keys(wins).forEach(function (k) { applyWinMenus(wins[k]); }); } catch (e) {} rerenderSettings(); }

  // light/dark mode (auto follows the OS via prefers-color-scheme)
  function modeChoice() { return localStorage.getItem('zx_mode') || 'auto'; }
  function resolveMode(c) { if (c === 'light') return 'light'; if (c === 'dark') return 'dark'; return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }
  function applyMode() { var c = modeChoice(); document.body.dataset.mode = resolveMode(c); return c; }
  function setMode(c) { localStorage.setItem('zx_mode', c); applyMode(); rerenderSettings(); }

  // ---------- i18n (English default; untranslated strings fall back to English) ----------
  var I18N = {
    es: { 'Send': 'Enviar', 'Route': 'Ruta', 'Save': 'Guardar', 'Close': 'Cerrar', 'Remove': 'Quitar', 'Delete': 'Eliminar', 'Import': 'Importar', 'Minimize': 'Minimizar', 'Maximize': 'Maximizar', 'Appearance': 'Apariencia', 'Engine': 'Motor', 'Providers': 'Proveedores', 'Skills': 'Habilidades', 'System': 'Sistema', 'Help': 'Ayuda', 'Desktop style': 'Estilo de escritorio', 'Appearance mode': 'Modo de apariencia', 'Language': 'Idioma', 'Auto': 'Auto', 'Light': 'Claro', 'Dark': 'Oscuro', 'All apps': 'Todas las apps', 'Search apps': 'Buscar apps', 'No apps match.': 'Ninguna app coincide.', 'Message': 'Mensaje para', 'New Agent': 'Nuevo agente', 'Settings': 'Ajustes', 'Attach files': 'Adjuntar archivos', 'You': 'Tú', 'connecting...': 'conectando...', 'connected': 'conectado', 'reconnecting': 'reconectando', 'error': 'error', 'thinking...': 'pensando...', 'uploading...': 'subiendo...', 'Loading...': 'Cargando...', 'Choose the interface language. Default is English; untranslated labels stay in English.': 'Elige el idioma de la interfaz. El valor predeterminado es inglés; las etiquetas sin traducir permanecen en inglés.', 'Auto follows your OS (detected: {os}). Override below.': 'Auto sigue tu SO (detectado: {os}). Cámbialo abajo.', '"Classic" opens the previous stable Zamolxis interface (the last stable version), kept as a fourth option.': "'Classic' abre la interfaz estable anterior de Zamolxis (la última versión estable), conservada como cuarta opción.", 'Auto follows your system light/dark preference (now: {mode}).': 'Auto sigue la preferencia clara/oscura del sistema (ahora: {mode}).', 'Each model can be a Claude variant, Local, or any authenticated free provider. Model = answers your chats · Fast = simple turns · Smartest = hard turns / final fallback. "Claude (default)" keeps Claude as the rescue tier.': "Cada modelo puede ser una variante de Claude, Local o cualquier proveedor gratuito autenticado. Modelo = responde tus chats · Rápido = turnos simples · Más inteligente = turnos difíciles / respaldo final. 'Claude (predeterminado)' mantiene a Claude como nivel de rescate.", 'Model (answers your chats)': 'Modelo (responde tus chats)', 'Fast model (simple turns)': 'Modelo rápido (turnos simples)', 'Smartest model (hard turns / final fallback)': 'Modelo más inteligente (turnos difíciles / respaldo final)', 'Assistant name': 'Nombre del asistente', 'Permission mode': 'Modo de permisos', 'Max turns': 'Turnos máximos', 'Max concurrent': 'Concurrencia máxima', 'Turn timeout (seconds)': 'Tiempo límite por turno (segundos)', 'How long a single turn may run before it is stopped. e.g. 3600 = 1 hour, 14400 = 4 hours. Applies live.': 'Cuánto puede durar un turno antes de detenerse. P. ej. 3600 = 1 hora, 14400 = 4 horas. Se aplica al instante.', 'Local-model routing (auto / off)': 'Enrutamiento de modelo local (auto / desactivado)', 'Routing': 'Enrutamiento', 'System prompt append': 'Texto añadido al prompt del sistema', 'Saving...': 'Guardando...', 'Saved.': 'Guardado.', ' Some changes need a restart (System tab).': ' Algunos cambios requieren reiniciar (pestaña Sistema).', 'Failed.': 'Falló.', 'Could not load settings.': 'No se pudieron cargar los ajustes.', 'Auto (smartest decides)': 'Auto (decide el más inteligente)', 'Free cloud (rotates free providers)': 'Nube gratuita (rota proveedores gratuitos)', 'Claude (subscription)': 'Claude (suscripción)', 'Loading providers...': 'Cargando proveedores...', 'Saving a key persists it; it takes effect after a restart (System tab).': 'Guardar una clave la conserva; surte efecto tras reiniciar (pestaña Sistema).', 'configured': 'configurado', '•••• set — paste to replace, or Save empty to remove': '•••• definida — pega para reemplazar, o Guarda vacío para quitar', 'Paste API key': 'Pega la clave API', 'Removing...': 'Quitando...', 'Removed.': 'Quitado.', 'Enter a key.': 'Introduce una clave.', 'Could not load providers.': 'No se pudieron cargar los proveedores.', 'Loading skills...': 'Cargando habilidades...', 'No skills match.': 'Ninguna habilidad coincide.', 'Could not load skills.': 'No se pudieron cargar las habilidades.', 'Search {n} skills': 'Buscar en {n} habilidades', 'Version': 'Versión', 'Primary model': 'Modelo principal', 'Fast model': 'Modelo rápido', 'Local model': 'Modelo local', 'Tokens (session)': 'Tokens (sesión)', '(none)': '(ninguno)', 'Updates': 'Actualizaciones', 'Update available — {n} new commit(s) on {branch}': 'Actualización disponible — {n} commit(s) nuevo(s) en {branch}', 'Up to date on {branch}.': 'Actualizado en {branch}.', 'Check for updates': 'Buscar actualizaciones', 'Upgrade': 'Actualizar', 'Upgrade now ({n})': 'Actualizar ahora ({n})', 'Checking...': 'Comprobando...', 'Check failed.': 'Falló la comprobación.', 'Upgrade Zamolxis now? It will pull the latest, rebuild, and restart (about a minute).': '¿Actualizar Zamolxis ahora? Descargará lo último, recompilará y reiniciará (alrededor de un minuto).', 'Upgrading — pulling, building, restarting...': 'Actualizando — descargando, compilando, reiniciando...', 'Updated — reloading...': 'Actualizado — recargando...', 'Still working... reload manually in a bit.': 'Aún trabajando... recarga manualmente en un momento.', 'Upgrade failed to start.': 'No se pudo iniciar la actualización.', 'Maintenance': 'Mantenimiento', 'Restart Zamolxis': 'Reiniciar Zamolxis', 'Open classic UI': 'Abrir interfaz clásica', 'Restarting...': 'Reiniciando...', 'Could not load status.': 'No se pudo cargar el estado.', 'Agent name': 'Nombre del agente', 'Instructions': 'Instrucciones', 'This becomes the agent app. It can run with or without a chat window.': 'Esto se convierte en la app del agente. Puede ejecutarse con o sin ventana de chat.', 'Model': 'Modelo', 'Auto, Local, Free cloud, any authenticated provider, or Claude.': 'Auto, Local, Nube gratuita, cualquier proveedor autenticado o Claude.', 'Create app': 'Crear app', 'Name is required.': 'El nombre es obligatorio.', 'Creating...': 'Creando...', 'Created. Added to the desktop.': 'Creado. Añadido al escritorio.', 'Backend unreachable.': 'Backend inaccesible.', 'e.g. researcher': 'p. ej. investigador', 'What should this agent do?': '¿Qué debe hacer este agente?', 'Toggle chat window for this app': 'Activar/desactivar la ventana de chat de esta app', 'Chat window': 'Ventana de chat', 'Run job': 'Ejecutar tarea', 'Running...': 'Ejecutando...', 'Done': 'Listo', 'Unreachable': 'Inaccesible', 'Ask me to do something, or give me a task.': 'Pídeme algo o asígname una tarea.', '(no reply)': '(sin respuesta)', 'Chat window is off — this agent runs headless: it executes its job on demand or on schedule via the existing agent/skill mechanism. Turn the chat on above to talk to it directly.': 'La ventana de chat está desactivada — este agente se ejecuta sin interfaz: realiza su tarea bajo demanda o según horario mediante el mecanismo de agentes/habilidades. Activa el chat arriba para hablar con él directamente.', 'Recent activity will appear here.': 'La actividad reciente aparecerá aquí.', 'Model: {m}': 'Modelo: {m}', '(default)': '(predeterminado)', 'Help & Guide': 'Ayuda y guía' },
    fr: { 'Send': 'Envoyer', 'Route': 'Routage', 'Save': 'Enregistrer', 'Close': 'Fermer', 'Remove': 'Retirer', 'Delete': 'Supprimer', 'Import': 'Importer', 'Minimize': 'Réduire', 'Maximize': 'Agrandir', 'Appearance': 'Apparence', 'Engine': 'Moteur', 'Providers': 'Fournisseurs', 'Skills': 'Compétences', 'System': 'Système', 'Help': 'Aide', 'Desktop style': 'Style du bureau', 'Appearance mode': "Mode d'apparence", 'Language': 'Langue', 'Auto': 'Auto', 'Light': 'Clair', 'Dark': 'Sombre', 'All apps': 'Toutes les apps', 'Search apps': 'Rechercher des apps', 'No apps match.': 'Aucune app ne correspond.', 'Message': 'Message à', 'New Agent': 'Nouvel agent', 'Settings': 'Paramètres', 'Attach files': 'Joindre des fichiers', 'You': 'Vous', 'connecting...': 'connexion...', 'connected': 'connecté', 'reconnecting': 'reconnexion', 'error': 'erreur', 'thinking...': 'réflexion...', 'uploading...': 'téléversement...', 'Loading...': 'Chargement...', 'Choose the interface language. Default is English; untranslated labels stay in English.': "Choisissez la langue de l'interface. La valeur par défaut est l'anglais ; les libellés non traduits restent en anglais.", 'Auto follows your OS (detected: {os}). Override below.': 'Auto suit votre SE (détecté : {os}). Modifiable ci-dessous.', '"Classic" opens the previous stable Zamolxis interface (the last stable version), kept as a fourth option.': '« Classic » ouvre l’ancienne interface stable de Zamolxis (la dernière version stable), conservée comme quatrième option.', 'Auto follows your system light/dark preference (now: {mode}).': 'Auto suit la préférence claire/sombre du système (actuel : {mode}).', 'Each model can be a Claude variant, Local, or any authenticated free provider. Model = answers your chats · Fast = simple turns · Smartest = hard turns / final fallback. "Claude (default)" keeps Claude as the rescue tier.': 'Chaque modèle peut être une variante de Claude, Local ou tout fournisseur gratuit authentifié. Modèle = répond à vos discussions · Rapide = tours simples · Plus intelligent = tours difficiles / dernier recours. « Claude (par défaut) » garde Claude comme niveau de secours.', 'Model (answers your chats)': 'Modèle (répond à vos discussions)', 'Fast model (simple turns)': 'Modèle rapide (tours simples)', 'Smartest model (hard turns / final fallback)': 'Modèle le plus intelligent (tours difficiles / dernier recours)', 'Assistant name': "Nom de l'assistant", 'Permission mode': 'Mode de permission', 'Max turns': 'Tours max', 'Max concurrent': 'Concurrence max', 'Turn timeout (seconds)': 'Délai par tour (secondes)', 'How long a single turn may run before it is stopped. e.g. 3600 = 1 hour, 14400 = 4 hours. Applies live.': "Durée maximale d'un tour avant son arrêt. Ex. 3600 = 1 heure, 14400 = 4 heures. Appliqué immédiatement.", 'Local-model routing (auto / off)': 'Routage du modèle local (auto / désactivé)', 'Routing': 'Routage', 'System prompt append': 'Ajout au prompt système', 'Saving...': 'Enregistrement...', 'Saved.': 'Enregistré.', ' Some changes need a restart (System tab).': ' Certains changements nécessitent un redémarrage (onglet Système).', 'Failed.': 'Échec.', 'Could not load settings.': 'Impossible de charger les paramètres.', 'Auto (smartest decides)': 'Auto (le plus intelligent décide)', 'Free cloud (rotates free providers)': 'Cloud gratuit (alterne les fournisseurs gratuits)', 'Claude (subscription)': 'Claude (abonnement)', 'Loading providers...': 'Chargement des fournisseurs...', 'Saving a key persists it; it takes effect after a restart (System tab).': 'Enregistrer une clé la conserve ; elle prend effet après un redémarrage (onglet Système).', 'configured': 'configuré', '•••• set — paste to replace, or Save empty to remove': '•••• définie — collez pour remplacer, ou Enregistrez vide pour retirer', 'Paste API key': 'Collez la clé API', 'Removing...': 'Suppression...', 'Removed.': 'Retiré.', 'Enter a key.': 'Saisissez une clé.', 'Could not load providers.': 'Impossible de charger les fournisseurs.', 'Loading skills...': 'Chargement des compétences...', 'No skills match.': 'Aucune compétence ne correspond.', 'Could not load skills.': 'Impossible de charger les compétences.', 'Search {n} skills': 'Rechercher dans {n} compétences', 'Version': 'Version', 'Primary model': 'Modèle principal', 'Fast model': 'Modèle rapide', 'Local model': 'Modèle local', 'Tokens (session)': 'Tokens (session)', '(none)': '(aucun)', 'Updates': 'Mises à jour', 'Update available — {n} new commit(s) on {branch}': 'Mise à jour disponible — {n} nouveau(x) commit(s) sur {branch}', 'Up to date on {branch}.': 'À jour sur {branch}.', 'Check for updates': 'Vérifier les mises à jour', 'Upgrade': 'Mettre à jour', 'Upgrade now ({n})': 'Mettre à jour ({n})', 'Checking...': 'Vérification...', 'Check failed.': 'Échec de la vérification.', 'Upgrade Zamolxis now? It will pull the latest, rebuild, and restart (about a minute).': 'Mettre à jour Zamolxis maintenant ? Il récupérera la dernière version, recompilera et redémarrera (environ une minute).', 'Upgrading — pulling, building, restarting...': 'Mise à jour — récupération, compilation, redémarrage...', 'Updated — reloading...': 'Mis à jour — rechargement...', 'Still working... reload manually in a bit.': 'Toujours en cours... rechargez manuellement dans un instant.', 'Upgrade failed to start.': 'Le démarrage de la mise à jour a échoué.', 'Maintenance': 'Maintenance', 'Restart Zamolxis': 'Redémarrer Zamolxis', 'Open classic UI': "Ouvrir l'interface classique", 'Restarting...': 'Redémarrage...', 'Could not load status.': "Impossible de charger l'état.", 'Agent name': "Nom de l'agent", 'Instructions': 'Instructions', 'This becomes the agent app. It can run with or without a chat window.': "Ceci devient l'app de l'agent. Elle peut fonctionner avec ou sans fenêtre de discussion.", 'Model': 'Modèle', 'Auto, Local, Free cloud, any authenticated provider, or Claude.': 'Auto, Local, Cloud gratuit, tout fournisseur authentifié ou Claude.', 'Create app': "Créer l'app", 'Name is required.': 'Le nom est requis.', 'Creating...': 'Création...', 'Created. Added to the desktop.': 'Créé. Ajouté au bureau.', 'Backend unreachable.': 'Backend inaccessible.', 'e.g. researcher': 'ex. chercheur', 'What should this agent do?': 'Que doit faire cet agent ?', 'Toggle chat window for this app': 'Activer/désactiver la fenêtre de discussion de cette app', 'Chat window': 'Fenêtre de discussion', 'Run job': 'Exécuter la tâche', 'Running...': 'Exécution...', 'Done': 'Terminé', 'Unreachable': 'Inaccessible', 'Ask me to do something, or give me a task.': 'Demandez-moi quelque chose ou confiez-moi une tâche.', '(no reply)': '(pas de réponse)', 'Chat window is off — this agent runs headless: it executes its job on demand or on schedule via the existing agent/skill mechanism. Turn the chat on above to talk to it directly.': "La fenêtre de discussion est désactivée — cet agent fonctionne sans interface : il exécute sa tâche à la demande ou selon un planning via le mécanisme agents/compétences existant. Activez le chat ci-dessus pour lui parler directement.", 'Recent activity will appear here.': "L'activité récente apparaîtra ici.", 'Model: {m}': 'Modèle : {m}', '(default)': '(par défaut)', 'Help & Guide': 'Aide et guide' },
    de: { 'Send': 'Senden', 'Route': 'Route', 'Save': 'Speichern', 'Close': 'Schließen', 'Remove': 'Entfernen', 'Delete': 'Löschen', 'Import': 'Importieren', 'Minimize': 'Minimieren', 'Maximize': 'Maximieren', 'Appearance': 'Darstellung', 'Engine': 'Engine', 'Providers': 'Anbieter', 'Skills': 'Fähigkeiten', 'System': 'System', 'Help': 'Hilfe', 'Desktop style': 'Desktop-Stil', 'Appearance mode': 'Darstellungsmodus', 'Language': 'Sprache', 'Auto': 'Auto', 'Light': 'Hell', 'Dark': 'Dunkel', 'All apps': 'Alle Apps', 'Search apps': 'Apps suchen', 'No apps match.': 'Keine App passt.', 'Message': 'Nachricht an', 'New Agent': 'Neuer Agent', 'Settings': 'Einstellungen', 'Attach files': 'Dateien anhängen', 'You': 'Du', 'connecting...': 'verbinden...', 'connected': 'verbunden', 'reconnecting': 'neu verbinden', 'error': 'Fehler', 'thinking...': 'denkt nach...', 'uploading...': 'lädt hoch...', 'Loading...': 'Wird geladen...', 'Choose the interface language. Default is English; untranslated labels stay in English.': 'Wählen Sie die Sprache der Oberfläche. Standard ist Englisch; nicht übersetzte Beschriftungen bleiben auf Englisch.', 'Auto follows your OS (detected: {os}). Override below.': 'Auto folgt Ihrem Betriebssystem (erkannt: {os}). Unten änderbar.', '"Classic" opens the previous stable Zamolxis interface (the last stable version), kept as a fourth option.': '„Classic“ öffnet die vorherige stabile Zamolxis-Oberfläche (die letzte stabile Version), als vierte Option erhalten.', 'Auto follows your system light/dark preference (now: {mode}).': 'Auto folgt der Hell-/Dunkel-Einstellung des Systems (jetzt: {mode}).', 'Each model can be a Claude variant, Local, or any authenticated free provider. Model = answers your chats · Fast = simple turns · Smartest = hard turns / final fallback. "Claude (default)" keeps Claude as the rescue tier.': 'Jedes Modell kann eine Claude-Variante, Local oder ein beliebiger authentifizierter kostenloser Anbieter sein. Modell = beantwortet Ihre Chats · Schnell = einfache Schritte · Klügstes = schwierige Schritte / letzte Rückfallebene. „Claude (Standard)“ behält Claude als Rettungsebene.', 'Model (answers your chats)': 'Modell (beantwortet Ihre Chats)', 'Fast model (simple turns)': 'Schnelles Modell (einfache Schritte)', 'Smartest model (hard turns / final fallback)': 'Klügstes Modell (schwierige Schritte / letzte Rückfallebene)', 'Assistant name': 'Name des Assistenten', 'Permission mode': 'Berechtigungsmodus', 'Max turns': 'Max. Schritte', 'Max concurrent': 'Max. gleichzeitig', 'Turn timeout (seconds)': 'Zeitlimit pro Schritt (Sekunden)', 'How long a single turn may run before it is stopped. e.g. 3600 = 1 hour, 14400 = 4 hours. Applies live.': 'Wie lange ein einzelner Schritt laufen darf, bevor er gestoppt wird. z. B. 3600 = 1 Stunde, 14400 = 4 Stunden. Sofort wirksam.', 'Local-model routing (auto / off)': 'Lokales Modell-Routing (auto / aus)', 'Routing': 'Routing', 'System prompt append': 'Zusatz zum System-Prompt', 'Saving...': 'Wird gespeichert...', 'Saved.': 'Gespeichert.', ' Some changes need a restart (System tab).': ' Einige Änderungen erfordern einen Neustart (Tab System).', 'Failed.': 'Fehlgeschlagen.', 'Could not load settings.': 'Einstellungen konnten nicht geladen werden.', 'Auto (smartest decides)': 'Auto (Klügstes entscheidet)', 'Free cloud (rotates free providers)': 'Kostenlose Cloud (wechselt kostenlose Anbieter)', 'Claude (subscription)': 'Claude (Abonnement)', 'Loading providers...': 'Anbieter werden geladen...', 'Saving a key persists it; it takes effect after a restart (System tab).': 'Ein gespeicherter Schlüssel bleibt erhalten; wirksam nach einem Neustart (Tab System).', 'configured': 'konfiguriert', '•••• set — paste to replace, or Save empty to remove': '•••• gesetzt — zum Ersetzen einfügen oder leer speichern zum Entfernen', 'Paste API key': 'API-Schlüssel einfügen', 'Removing...': 'Wird entfernt...', 'Removed.': 'Entfernt.', 'Enter a key.': 'Schlüssel eingeben.', 'Could not load providers.': 'Anbieter konnten nicht geladen werden.', 'Loading skills...': 'Fähigkeiten werden geladen...', 'No skills match.': 'Keine Fähigkeit passt.', 'Could not load skills.': 'Fähigkeiten konnten nicht geladen werden.', 'Search {n} skills': '{n} Fähigkeiten durchsuchen', 'Version': 'Version', 'Primary model': 'Primäres Modell', 'Fast model': 'Schnelles Modell', 'Local model': 'Lokales Modell', 'Tokens (session)': 'Tokens (Sitzung)', '(none)': '(keins)', 'Updates': 'Updates', 'Update available — {n} new commit(s) on {branch}': 'Update verfügbar — {n} neue(r) Commit(s) auf {branch}', 'Up to date on {branch}.': 'Aktuell auf {branch}.', 'Check for updates': 'Nach Updates suchen', 'Upgrade': 'Aktualisieren', 'Upgrade now ({n})': 'Jetzt aktualisieren ({n})', 'Checking...': 'Wird geprüft...', 'Check failed.': 'Prüfung fehlgeschlagen.', 'Upgrade Zamolxis now? It will pull the latest, rebuild, and restart (about a minute).': 'Zamolxis jetzt aktualisieren? Es lädt die neueste Version, baut neu und startet neu (etwa eine Minute).', 'Upgrading — pulling, building, restarting...': 'Aktualisierung — laden, bauen, neu starten...', 'Updated — reloading...': 'Aktualisiert — wird neu geladen...', 'Still working... reload manually in a bit.': 'Läuft noch... in Kürze manuell neu laden.', 'Upgrade failed to start.': 'Update konnte nicht gestartet werden.', 'Maintenance': 'Wartung', 'Restart Zamolxis': 'Zamolxis neu starten', 'Open classic UI': 'Klassische Oberfläche öffnen', 'Restarting...': 'Neustart...', 'Could not load status.': 'Status konnte nicht geladen werden.', 'Agent name': 'Name des Agenten', 'Instructions': 'Anweisungen', 'This becomes the agent app. It can run with or without a chat window.': 'Daraus wird die Agent-App. Sie kann mit oder ohne Chatfenster laufen.', 'Model': 'Modell', 'Auto, Local, Free cloud, any authenticated provider, or Claude.': 'Auto, Local, Kostenlose Cloud, beliebiger authentifizierter Anbieter oder Claude.', 'Create app': 'App erstellen', 'Name is required.': 'Name ist erforderlich.', 'Creating...': 'Wird erstellt...', 'Created. Added to the desktop.': 'Erstellt. Zum Desktop hinzugefügt.', 'Backend unreachable.': 'Backend nicht erreichbar.', 'e.g. researcher': 'z. B. Rechercheur', 'What should this agent do?': 'Was soll dieser Agent tun?', 'Toggle chat window for this app': 'Chatfenster für diese App umschalten', 'Chat window': 'Chatfenster', 'Run job': 'Aufgabe ausführen', 'Running...': 'Wird ausgeführt...', 'Done': 'Fertig', 'Unreachable': 'Nicht erreichbar', 'Ask me to do something, or give me a task.': 'Bitte mich um etwas oder gib mir eine Aufgabe.', '(no reply)': '(keine Antwort)', 'Chat window is off — this agent runs headless: it executes its job on demand or on schedule via the existing agent/skill mechanism. Turn the chat on above to talk to it directly.': 'Das Chatfenster ist aus — dieser Agent läuft ohne Oberfläche: Er erledigt seine Aufgabe auf Abruf oder nach Zeitplan über den vorhandenen Agenten-/Fähigkeiten-Mechanismus. Schalten Sie den Chat oben ein, um direkt mit ihm zu sprechen.', 'Recent activity will appear here.': 'Aktuelle Aktivität erscheint hier.', 'Model: {m}': 'Modell: {m}', '(default)': '(Standard)', 'Help & Guide': 'Hilfe und Anleitung' },
    ro: { 'Send': 'Trimite', 'Route': 'Rutare', 'Save': 'Salvează', 'Close': 'Închide', 'Remove': 'Elimină', 'Delete': 'Șterge', 'Import': 'Importă', 'Minimize': 'Minimizează', 'Maximize': 'Maximizează', 'Appearance': 'Aspect', 'Engine': 'Motor', 'Providers': 'Furnizori', 'Skills': 'Abilități', 'System': 'Sistem', 'Help': 'Ajutor', 'Desktop style': 'Stil desktop', 'Appearance mode': 'Mod de aspect', 'Language': 'Limbă', 'Auto': 'Auto', 'Light': 'Luminos', 'Dark': 'Întunecat', 'All apps': 'Toate aplicațiile', 'Search apps': 'Caută aplicații', 'No apps match.': 'Nicio aplicație nu corespunde.', 'Message': 'Mesaj către', 'New Agent': 'Agent nou', 'Settings': 'Setări', 'Attach files': 'Atașează fișiere', 'You': 'Tu', 'connecting...': 'se conectează...', 'connected': 'conectat', 'reconnecting': 'se reconectează', 'error': 'eroare', 'thinking...': 'gândește...', 'uploading...': 'se încarcă...', 'Loading...': 'Se încarcă...', 'Choose the interface language. Default is English; untranslated labels stay in English.': 'Alege limba interfeței. Implicit este engleza; etichetele netraduse rămân în engleză.', 'Auto follows your OS (detected: {os}). Override below.': 'Auto urmează sistemul de operare (detectat: {os}). Modifică mai jos.', '"Classic" opens the previous stable Zamolxis interface (the last stable version), kept as a fourth option.': '„Classic” deschide interfața stabilă anterioară Zamolxis (ultima versiune stabilă), păstrată ca a patra opțiune.', 'Auto follows your system light/dark preference (now: {mode}).': 'Auto urmează preferința luminos/întunecat a sistemului (acum: {mode}).', 'Each model can be a Claude variant, Local, or any authenticated free provider. Model = answers your chats · Fast = simple turns · Smartest = hard turns / final fallback. "Claude (default)" keeps Claude as the rescue tier.': 'Fiecare model poate fi o variantă Claude, Local sau orice furnizor gratuit autentificat. Model = răspunde la conversații · Rapid = ture simple · Cel mai inteligent = ture dificile / rezervă finală. „Claude (implicit)” păstrează Claude ca nivel de salvare.', 'Model (answers your chats)': 'Model (răspunde la conversații)', 'Fast model (simple turns)': 'Model rapid (ture simple)', 'Smartest model (hard turns / final fallback)': 'Cel mai inteligent model (ture dificile / rezervă finală)', 'Assistant name': 'Numele asistentului', 'Permission mode': 'Mod de permisiune', 'Max turns': 'Ture maxime', 'Max concurrent': 'Concurență maximă', 'Turn timeout (seconds)': 'Timp limită pe tură (secunde)', 'How long a single turn may run before it is stopped. e.g. 3600 = 1 hour, 14400 = 4 hours. Applies live.': 'Cât poate rula o singură tură înainte de a fi oprită. Ex. 3600 = 1 oră, 14400 = 4 ore. Se aplică imediat.', 'Local-model routing (auto / off)': 'Rutare model local (auto / oprit)', 'Routing': 'Rutare', 'System prompt append': 'Adăugare la promptul de sistem', 'Saving...': 'Se salvează...', 'Saved.': 'Salvat.', ' Some changes need a restart (System tab).': ' Unele modificări necesită repornire (fila Sistem).', 'Failed.': 'Eșuat.', 'Could not load settings.': 'Setările nu au putut fi încărcate.', 'Auto (smartest decides)': 'Auto (decide cel mai inteligent)', 'Free cloud (rotates free providers)': 'Cloud gratuit (rotește furnizorii gratuiți)', 'Claude (subscription)': 'Claude (abonament)', 'Loading providers...': 'Se încarcă furnizorii...', 'Saving a key persists it; it takes effect after a restart (System tab).': 'O cheie salvată este păstrată; intră în vigoare după repornire (fila Sistem).', 'configured': 'configurat', '•••• set — paste to replace, or Save empty to remove': '•••• setată — lipește pentru a înlocui sau Salvează gol pentru a elimina', 'Paste API key': 'Lipește cheia API', 'Removing...': 'Se elimină...', 'Removed.': 'Eliminat.', 'Enter a key.': 'Introdu o cheie.', 'Could not load providers.': 'Furnizorii nu au putut fi încărcați.', 'Loading skills...': 'Se încarcă abilitățile...', 'No skills match.': 'Nicio abilitate nu corespunde.', 'Could not load skills.': 'Abilitățile nu au putut fi încărcate.', 'Search {n} skills': 'Caută în {n} abilități', 'Version': 'Versiune', 'Primary model': 'Model principal', 'Fast model': 'Model rapid', 'Local model': 'Model local', 'Tokens (session)': 'Tokenuri (sesiune)', '(none)': '(niciunul)', 'Updates': 'Actualizări', 'Update available — {n} new commit(s) on {branch}': 'Actualizare disponibilă — {n} commit(uri) noi pe {branch}', 'Up to date on {branch}.': 'La zi pe {branch}.', 'Check for updates': 'Caută actualizări', 'Upgrade': 'Actualizează', 'Upgrade now ({n})': 'Actualizează acum ({n})', 'Checking...': 'Se verifică...', 'Check failed.': 'Verificarea a eșuat.', 'Upgrade Zamolxis now? It will pull the latest, rebuild, and restart (about a minute).': 'Actualizezi Zamolxis acum? Va descărca ultima versiune, va recompila și va reporni (circa un minut).', 'Upgrading — pulling, building, restarting...': 'Se actualizează — descărcare, compilare, repornire...', 'Updated — reloading...': 'Actualizat — se reîncarcă...', 'Still working... reload manually in a bit.': 'Încă lucrează... reîncarcă manual în scurt timp.', 'Upgrade failed to start.': 'Actualizarea nu a putut porni.', 'Maintenance': 'Întreținere', 'Restart Zamolxis': 'Repornește Zamolxis', 'Open classic UI': 'Deschide interfața clasică', 'Restarting...': 'Se repornește...', 'Could not load status.': 'Starea nu a putut fi încărcată.', 'Agent name': 'Numele agentului', 'Instructions': 'Instrucțiuni', 'This becomes the agent app. It can run with or without a chat window.': 'Aceasta devine aplicația agentului. Poate rula cu sau fără fereastră de chat.', 'Model': 'Model', 'Auto, Local, Free cloud, any authenticated provider, or Claude.': 'Auto, Local, Cloud gratuit, orice furnizor autentificat sau Claude.', 'Create app': 'Creează aplicația', 'Name is required.': 'Numele este obligatoriu.', 'Creating...': 'Se creează...', 'Created. Added to the desktop.': 'Creat. Adăugat pe desktop.', 'Backend unreachable.': 'Backend inaccesibil.', 'e.g. researcher': 'ex. cercetător', 'What should this agent do?': 'Ce ar trebui să facă acest agent?', 'Toggle chat window for this app': 'Comută fereastra de chat pentru această aplicație', 'Chat window': 'Fereastră de chat', 'Run job': 'Rulează sarcina', 'Running...': 'Se rulează...', 'Done': 'Gata', 'Unreachable': 'Inaccesibil', 'Ask me to do something, or give me a task.': 'Cere-mi ceva sau dă-mi o sarcină.', '(no reply)': '(niciun răspuns)', 'Chat window is off — this agent runs headless: it executes its job on demand or on schedule via the existing agent/skill mechanism. Turn the chat on above to talk to it directly.': 'Fereastra de chat este oprită — acest agent rulează fără interfață: își execută sarcina la cerere sau programat, prin mecanismul existent de agenți/abilități. Activează chatul de mai sus pentru a vorbi direct cu el.', 'Recent activity will appear here.': 'Activitatea recentă va apărea aici.', 'Model: {m}': 'Model: {m}', '(default)': '(implicit)', 'Help & Guide': 'Ajutor și ghid' },
    it: { 'Send': 'Invia', 'Route': 'Instradamento', 'Save': 'Salva', 'Close': 'Chiudi', 'Remove': 'Rimuovi', 'Delete': 'Elimina', 'Import': 'Importa', 'Minimize': 'Riduci a icona', 'Maximize': 'Ingrandisci', 'Appearance': 'Aspetto', 'Engine': 'Motore', 'Providers': 'Provider', 'Skills': 'Competenze', 'System': 'Sistema', 'Help': 'Aiuto', 'Desktop style': 'Stile desktop', 'Appearance mode': 'Modalità aspetto', 'Language': 'Lingua', 'Auto': 'Auto', 'Light': 'Chiaro', 'Dark': 'Scuro', 'All apps': 'Tutte le app', 'Search apps': 'Cerca app', 'No apps match.': 'Nessuna app corrisponde.', 'Message': 'Messaggio a', 'New Agent': 'Nuovo agente', 'Settings': 'Impostazioni', 'Attach files': 'Allega file', 'You': 'Tu', 'connecting...': 'connessione...', 'connected': 'connesso', 'reconnecting': 'riconnessione', 'error': 'errore', 'thinking...': 'sto pensando...', 'uploading...': 'caricamento...', 'Loading...': 'Caricamento...', 'Choose the interface language. Default is English; untranslated labels stay in English.': "Scegli la lingua dell'interfaccia. L'impostazione predefinita è l'inglese; le etichette non tradotte restano in inglese.", 'Auto follows your OS (detected: {os}). Override below.': 'Auto segue il tuo SO (rilevato: {os}). Modificabile sotto.', '"Classic" opens the previous stable Zamolxis interface (the last stable version), kept as a fourth option.': "« Classic » apre la precedente interfaccia stabile di Zamolxis (l'ultima versione stabile), mantenuta come quarta opzione.", 'Auto follows your system light/dark preference (now: {mode}).': 'Auto segue la preferenza chiaro/scuro del sistema (ora: {mode}).', 'Each model can be a Claude variant, Local, or any authenticated free provider. Model = answers your chats · Fast = simple turns · Smartest = hard turns / final fallback. "Claude (default)" keeps Claude as the rescue tier.': 'Ogni modello può essere una variante di Claude, Local o qualsiasi provider gratuito autenticato. Modello = risponde alle chat · Veloce = turni semplici · Più intelligente = turni difficili / ripiego finale. « Claude (predefinito) » mantiene Claude come livello di soccorso.', 'Model (answers your chats)': 'Modello (risponde alle chat)', 'Fast model (simple turns)': 'Modello veloce (turni semplici)', 'Smartest model (hard turns / final fallback)': 'Modello più intelligente (turni difficili / ripiego finale)', 'Assistant name': "Nome dell'assistente", 'Permission mode': 'Modalità autorizzazioni', 'Max turns': 'Turni max', 'Max concurrent': 'Concorrenza max', 'Turn timeout (seconds)': 'Timeout per turno (secondi)', 'How long a single turn may run before it is stopped. e.g. 3600 = 1 hour, 14400 = 4 hours. Applies live.': 'Per quanto può durare un singolo turno prima di essere fermato. Es. 3600 = 1 ora, 14400 = 4 ore. Applicato subito.', 'Local-model routing (auto / off)': 'Instradamento modello locale (auto / off)', 'Routing': 'Instradamento', 'System prompt append': 'Aggiunta al prompt di sistema', 'Saving...': 'Salvataggio...', 'Saved.': 'Salvato.', ' Some changes need a restart (System tab).': ' Alcune modifiche richiedono un riavvio (scheda Sistema).', 'Failed.': 'Non riuscito.', 'Could not load settings.': 'Impossibile caricare le impostazioni.', 'Auto (smartest decides)': 'Auto (decide il più intelligente)', 'Free cloud (rotates free providers)': 'Cloud gratuito (alterna i provider gratuiti)', 'Claude (subscription)': 'Claude (abbonamento)', 'Loading providers...': 'Caricamento provider...', 'Saving a key persists it; it takes effect after a restart (System tab).': 'Salvare una chiave la conserva; ha effetto dopo un riavvio (scheda Sistema).', 'configured': 'configurato', '•••• set — paste to replace, or Save empty to remove': '•••• impostata — incolla per sostituire, o Salva vuoto per rimuovere', 'Paste API key': 'Incolla la chiave API', 'Removing...': 'Rimozione...', 'Removed.': 'Rimosso.', 'Enter a key.': 'Inserisci una chiave.', 'Could not load providers.': 'Impossibile caricare i provider.', 'Loading skills...': 'Caricamento competenze...', 'No skills match.': 'Nessuna competenza corrisponde.', 'Could not load skills.': 'Impossibile caricare le competenze.', 'Search {n} skills': 'Cerca tra {n} competenze', 'Version': 'Versione', 'Primary model': 'Modello principale', 'Fast model': 'Modello veloce', 'Local model': 'Modello locale', 'Tokens (session)': 'Token (sessione)', '(none)': '(nessuno)', 'Updates': 'Aggiornamenti', 'Update available — {n} new commit(s) on {branch}': 'Aggiornamento disponibile — {n} nuovo/i commit su {branch}', 'Up to date on {branch}.': 'Aggiornato su {branch}.', 'Check for updates': 'Verifica aggiornamenti', 'Upgrade': 'Aggiorna', 'Upgrade now ({n})': 'Aggiorna ora ({n})', 'Checking...': 'Verifica...', 'Check failed.': 'Verifica non riuscita.', 'Upgrade Zamolxis now? It will pull the latest, rebuild, and restart (about a minute).': "Aggiornare Zamolxis ora? Scaricherà l'ultima versione, ricompilerà e riavvierà (circa un minuto).", 'Upgrading — pulling, building, restarting...': 'Aggiornamento — download, build, riavvio...', 'Updated — reloading...': 'Aggiornato — ricaricamento...', 'Still working... reload manually in a bit.': 'Ancora in corso... ricarica manualmente tra poco.', 'Upgrade failed to start.': "Avvio dell'aggiornamento non riuscito.", 'Maintenance': 'Manutenzione', 'Restart Zamolxis': 'Riavvia Zamolxis', 'Open classic UI': "Apri l'interfaccia classica", 'Restarting...': 'Riavvio...', 'Could not load status.': 'Impossibile caricare lo stato.', 'Agent name': "Nome dell'agente", 'Instructions': 'Istruzioni', 'This becomes the agent app. It can run with or without a chat window.': "Questo diventa l'app dell'agente. Può funzionare con o senza finestra di chat.", 'Model': 'Modello', 'Auto, Local, Free cloud, any authenticated provider, or Claude.': 'Auto, Local, Cloud gratuito, qualsiasi provider autenticato o Claude.', 'Create app': "Crea l'app", 'Name is required.': 'Il nome è obbligatorio.', 'Creating...': 'Creazione...', 'Created. Added to the desktop.': 'Creato. Aggiunto al desktop.', 'Backend unreachable.': 'Backend non raggiungibile.', 'e.g. researcher': 'es. ricercatore', 'What should this agent do?': 'Cosa deve fare questo agente?', 'Toggle chat window for this app': 'Attiva/disattiva la finestra di chat per questa app', 'Chat window': 'Finestra di chat', 'Run job': 'Esegui attività', 'Running...': 'Esecuzione...', 'Done': 'Fatto', 'Unreachable': 'Non raggiungibile', 'Ask me to do something, or give me a task.': "Chiedimi qualcosa o assegnami un'attività.", '(no reply)': '(nessuna risposta)', 'Chat window is off — this agent runs headless: it executes its job on demand or on schedule via the existing agent/skill mechanism. Turn the chat on above to talk to it directly.': "La finestra di chat è disattivata — questo agente funziona senza interfaccia: esegue la sua attività su richiesta o pianificata tramite il meccanismo esistente di agenti/competenze. Attiva la chat sopra per parlargli direttamente.", 'Recent activity will appear here.': "L'attività recente apparirà qui.", 'Model: {m}': 'Modello: {m}', '(default)': '(predefinito)', 'Help & Guide': 'Aiuto e guida' }
  };
  var LANGS = [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'], ['ro', 'Română'], ['it', 'Italiano']];
  // App names, categories and File-Manager UI strings (merged into I18N to keep the main table readable).
  var I18N_APPS = {
    es: { 'Files': 'Archivos', 'Text Editor': 'Editor de texto', 'Calculator': 'Calculadora', 'Image Viewer': 'Visor de imágenes', 'Media Player': 'Reproductor multimedia', 'Ebook Reader': 'Lector de libros', 'Word': 'Word', 'Excel': 'Excel', 'SFTP Client': 'Cliente SFTP', 'Telnet': 'Telnet', 'Messages': 'Mensajes', 'Office': 'Oficina', 'Media': 'Multimedia', 'Network': 'Red', 'Utilities': 'Utilidades', 'Communication': 'Comunicación', 'Agents': 'Agentes', 'Apps': 'Apps', 'New file': 'Nuevo archivo', 'New folder': 'Nueva carpeta', 'Rename': 'Renombrar', 'Download': 'Descargar', 'Refresh': 'Actualizar', 'Open': 'Abrir', 'Open from File Manager': 'Abrir desde el Administrador de archivos', 'No file open': 'Ningún archivo abierto', 'Ask Zamolxis to edit': 'Pedir a Zamolxis que edite', 'empty folder': 'carpeta vacía', 'Could not open.': 'No se pudo abrir.' },
    fr: { 'Files': 'Fichiers', 'Text Editor': 'Éditeur de texte', 'Calculator': 'Calculatrice', 'Image Viewer': "Visionneuse d'images", 'Media Player': 'Lecteur multimédia', 'Ebook Reader': 'Lecteur de livres', 'Word': 'Word', 'Excel': 'Excel', 'SFTP Client': 'Client SFTP', 'Telnet': 'Telnet', 'Messages': 'Messages', 'Office': 'Bureautique', 'Media': 'Multimédia', 'Network': 'Réseau', 'Utilities': 'Utilitaires', 'Communication': 'Communication', 'Agents': 'Agents', 'Apps': 'Apps', 'New file': 'Nouveau fichier', 'New folder': 'Nouveau dossier', 'Rename': 'Renommer', 'Download': 'Télécharger', 'Refresh': 'Actualiser', 'Open': 'Ouvrir', 'Open from File Manager': 'Ouvrir depuis le Gestionnaire de fichiers', 'No file open': 'Aucun fichier ouvert', 'Ask Zamolxis to edit': 'Demander à Zamolxis de modifier', 'empty folder': 'dossier vide', 'Could not open.': "Impossible d'ouvrir." },
    de: { 'Files': 'Dateien', 'Text Editor': 'Texteditor', 'Calculator': 'Rechner', 'Image Viewer': 'Bildbetrachter', 'Media Player': 'Medienplayer', 'Ebook Reader': 'E-Book-Reader', 'Word': 'Word', 'Excel': 'Excel', 'SFTP Client': 'SFTP-Client', 'Telnet': 'Telnet', 'Messages': 'Nachrichten', 'Office': 'Büro', 'Media': 'Medien', 'Network': 'Netzwerk', 'Utilities': 'Dienstprogramme', 'Communication': 'Kommunikation', 'Agents': 'Agenten', 'Apps': 'Apps', 'New file': 'Neue Datei', 'New folder': 'Neuer Ordner', 'Rename': 'Umbenennen', 'Download': 'Herunterladen', 'Refresh': 'Aktualisieren', 'Open': 'Öffnen', 'Open from File Manager': 'Im Datei-Manager öffnen', 'No file open': 'Keine Datei geöffnet', 'Ask Zamolxis to edit': 'Zamolxis um Bearbeitung bitten', 'empty folder': 'leerer Ordner', 'Could not open.': 'Konnte nicht geöffnet werden.' },
    ro: { 'Files': 'Fișiere', 'Text Editor': 'Editor de text', 'Calculator': 'Calculator', 'Image Viewer': 'Vizualizator imagini', 'Media Player': 'Player media', 'Ebook Reader': 'Cititor de cărți', 'Word': 'Word', 'Excel': 'Excel', 'SFTP Client': 'Client SFTP', 'Telnet': 'Telnet', 'Messages': 'Mesaje', 'Office': 'Birou', 'Media': 'Media', 'Network': 'Rețea', 'Utilities': 'Utilitare', 'Communication': 'Comunicare', 'Agents': 'Agenți', 'Apps': 'Aplicații', 'New file': 'Fișier nou', 'New folder': 'Dosar nou', 'Rename': 'Redenumește', 'Download': 'Descarcă', 'Refresh': 'Reîmprospătează', 'Open': 'Deschide', 'Open from File Manager': 'Deschide din Managerul de fișiere', 'No file open': 'Niciun fișier deschis', 'Ask Zamolxis to edit': 'Cere lui Zamolxis să editeze', 'empty folder': 'dosar gol', 'Could not open.': 'Nu s-a putut deschide.' },
    it: { 'Files': 'File', 'Text Editor': 'Editor di testo', 'Calculator': 'Calcolatrice', 'Image Viewer': 'Visualizzatore immagini', 'Media Player': 'Lettore multimediale', 'Ebook Reader': 'Lettore di e-book', 'Word': 'Word', 'Excel': 'Excel', 'SFTP Client': 'Client SFTP', 'Telnet': 'Telnet', 'Messages': 'Messaggi', 'Office': 'Ufficio', 'Media': 'Multimedia', 'Network': 'Rete', 'Utilities': 'Utilità', 'Communication': 'Comunicazione', 'Agents': 'Agenti', 'Apps': 'App', 'New file': 'Nuovo file', 'New folder': 'Nuova cartella', 'Rename': 'Rinomina', 'Download': 'Scarica', 'Refresh': 'Aggiorna', 'Open': 'Apri', 'Open from File Manager': 'Apri dal File Manager', 'No file open': 'Nessun file aperto', 'Ask Zamolxis to edit': 'Chiedi a Zamolxis di modificare', 'empty folder': 'cartella vuota', 'Could not open.': 'Impossibile aprire.' }
  };
  Object.keys(I18N_APPS).forEach(function (l) { if (I18N[l]) Object.keys(I18N_APPS[l]).forEach(function (k) { I18N[l][k] = I18N_APPS[l][k]; }); });
  // Application-menu labels.
  var I18N_MENUS = {
    es: { 'File': 'Archivo', 'Edit': 'Editar', 'View': 'Ver', 'Page': 'Página', 'Session': 'Sesión', 'New': 'Nuevo', 'Select all': 'Seleccionar todo', 'Rotate': 'Rotar', 'Delete page': 'Eliminar página', 'Save as new file': 'Guardar como nuevo', 'Connect': 'Conectar', 'Disconnect': 'Desconectar', 'Upload': 'Subir', 'Save As': 'Guardar como' },
    fr: { 'File': 'Fichier', 'Edit': 'Édition', 'View': 'Affichage', 'Page': 'Page', 'Session': 'Session', 'New': 'Nouveau', 'Select all': 'Tout sélectionner', 'Rotate': 'Pivoter', 'Delete page': 'Supprimer la page', 'Save as new file': 'Enregistrer comme nouveau', 'Connect': 'Connecter', 'Disconnect': 'Déconnecter', 'Upload': 'Téléverser', 'Save As': 'Enregistrer sous' },
    de: { 'File': 'Datei', 'Edit': 'Bearbeiten', 'View': 'Ansicht', 'Page': 'Seite', 'Session': 'Sitzung', 'New': 'Neu', 'Select all': 'Alles auswählen', 'Rotate': 'Drehen', 'Delete page': 'Seite löschen', 'Save as new file': 'Als neue Datei speichern', 'Connect': 'Verbinden', 'Disconnect': 'Trennen', 'Upload': 'Hochladen', 'Save As': 'Speichern unter' },
    ro: { 'File': 'Fișier', 'Edit': 'Editare', 'View': 'Vizualizare', 'Page': 'Pagină', 'Session': 'Sesiune', 'New': 'Nou', 'Select all': 'Selectează tot', 'Rotate': 'Rotește', 'Delete page': 'Șterge pagina', 'Save as new file': 'Salvează ca fișier nou', 'Connect': 'Conectează', 'Disconnect': 'Deconectează', 'Upload': 'Încarcă', 'Save As': 'Salvează ca' },
    it: { 'File': 'File', 'Edit': 'Modifica', 'View': 'Visualizza', 'Page': 'Pagina', 'Session': 'Sessione', 'New': 'Nuovo', 'Select all': 'Seleziona tutto', 'Rotate': 'Ruota', 'Delete page': 'Elimina pagina', 'Save as new file': 'Salva come nuovo file', 'Connect': 'Connetti', 'Disconnect': 'Disconnetti', 'Upload': 'Carica', 'Save As': 'Salva con nome' }
  };
  Object.keys(I18N_MENUS).forEach(function (l) { if (I18N[l]) Object.keys(I18N_MENUS[l]).forEach(function (k) { I18N[l][k] = I18N_MENUS[l][k]; }); });
  var I18N_SET = {
    es: { 'Timezone': 'Zona horaria', 'Autostart': 'Inicio automático', 'Run Zamolxis at login': 'Ejecutar Zamolxis al iniciar sesión', 'Export setup': 'Exportar configuración', 'Channels': 'Canales', 'Enable a channel and add its credentials. Changes take effect after a restart (System tab).': 'Activa un canal y añade sus credenciales. Los cambios surten efecto tras reiniciar (pestaña Sistema).' },
    fr: { 'Timezone': 'Fuseau horaire', 'Autostart': 'Démarrage auto', 'Run Zamolxis at login': 'Lancer Zamolxis à la connexion', 'Export setup': 'Exporter la configuration', 'Channels': 'Canaux', 'Enable a channel and add its credentials. Changes take effect after a restart (System tab).': "Activez un canal et ajoutez ses identifiants. Les changements prennent effet après un redémarrage (onglet Système)." },
    de: { 'Timezone': 'Zeitzone', 'Autostart': 'Autostart', 'Run Zamolxis at login': 'Zamolxis bei Anmeldung starten', 'Export setup': 'Setup exportieren', 'Channels': 'Kanäle', 'Enable a channel and add its credentials. Changes take effect after a restart (System tab).': 'Aktivieren Sie einen Kanal und fügen Sie seine Anmeldedaten hinzu. Änderungen werden nach einem Neustart wirksam (Tab System).' },
    ro: { 'Timezone': 'Fus orar', 'Autostart': 'Pornire automată', 'Run Zamolxis at login': 'Pornește Zamolxis la autentificare', 'Export setup': 'Exportă configurația', 'Channels': 'Canale', 'Enable a channel and add its credentials. Changes take effect after a restart (System tab).': 'Activează un canal și adaugă-i credențialele. Modificările intră în vigoare după repornire (fila Sistem).' },
    it: { 'Timezone': 'Fuso orario', 'Autostart': 'Avvio automatico', 'Run Zamolxis at login': "Avvia Zamolxis all'accesso", 'Export setup': 'Esporta configurazione', 'Channels': 'Canali', 'Enable a channel and add its credentials. Changes take effect after a restart (System tab).': 'Abilita un canale e aggiungi le sue credenziali. Le modifiche hanno effetto dopo un riavvio (scheda Sistema).' }
  };
  Object.keys(I18N_SET).forEach(function (l) { if (I18N[l]) Object.keys(I18N_SET[l]).forEach(function (k) { I18N[l][k] = I18N_SET[l][k]; }); });
  var I18N_X = {
    es: { 'Clear conversation': 'Borrar conversación', 'Select a file to open': 'Selecciona un archivo para abrir' },
    fr: { 'Clear conversation': 'Effacer la conversation', 'Select a file to open': 'Sélectionnez un fichier à ouvrir' },
    de: { 'Clear conversation': 'Unterhaltung löschen', 'Select a file to open': 'Wählen Sie eine Datei zum Öffnen' },
    ro: { 'Clear conversation': 'Șterge conversația', 'Select a file to open': 'Selectează un fișier de deschis' },
    it: { 'Clear conversation': 'Cancella conversazione', 'Select a file to open': 'Seleziona un file da aprire' }
  };
  Object.keys(I18N_X).forEach(function (l) { if (I18N[l]) Object.keys(I18N_X[l]).forEach(function (k) { I18N[l][k] = I18N_X[l][k]; }); });
  var I18N_DISP = {
    es: { 'Notes': 'Notas', 'Database': 'Base de datos', 'History': 'Historial', 'Mail': 'Correo', 'Calendar': 'Calendario', 'Contacts': 'Contactos', 'Tasks': 'Tareas', 'Run': 'Ejecutar', 'Bookmarks': 'Marcadores', 'Search': 'Buscar', 'no rows': 'sin filas' },
    fr: { 'Notes': 'Notes', 'Database': 'Base de données', 'History': 'Historique', 'Mail': 'Courrier', 'Calendar': 'Calendrier', 'Contacts': 'Contacts', 'Tasks': 'Tâches', 'Run': 'Exécuter', 'Bookmarks': 'Favoris', 'Search': 'Rechercher', 'no rows': 'aucune ligne' },
    de: { 'Notes': 'Notizen', 'Database': 'Datenbank', 'History': 'Verlauf', 'Mail': 'E-Mail', 'Calendar': 'Kalender', 'Contacts': 'Kontakte', 'Tasks': 'Aufgaben', 'Run': 'Ausführen', 'Bookmarks': 'Lesezeichen', 'Search': 'Suchen', 'no rows': 'keine Zeilen' },
    ro: { 'Notes': 'Note', 'Database': 'Bază de date', 'History': 'Istoric', 'Mail': 'Poștă', 'Calendar': 'Calendar', 'Contacts': 'Contacte', 'Tasks': 'Sarcini', 'Run': 'Rulează', 'Bookmarks': 'Marcaje', 'Search': 'Caută', 'no rows': 'niciun rând' },
    it: { 'Notes': 'Note', 'Database': 'Database', 'History': 'Cronologia', 'Mail': 'Posta', 'Calendar': 'Calendario', 'Contacts': 'Contatti', 'Tasks': 'Attività', 'Run': 'Esegui', 'Bookmarks': 'Segnalibri', 'Search': 'Cerca', 'no rows': 'nessuna riga' }
  };
  Object.keys(I18N_DISP).forEach(function (l) { if (I18N[l]) Object.keys(I18N_DISP[l]).forEach(function (k) { I18N[l][k] = I18N_DISP[l][k]; }); });
  function langChoice() { return localStorage.getItem('zx_lang') || 'en'; }
  function T(s) { var L = langChoice(); if (L === 'en') return s; var d = I18N[L]; return (d && d[s]) || s; }
  function Tf(s, vars) { var out = T(s); if (vars) Object.keys(vars).forEach(function (k) { out = out.split('{' + k + '}').join(vars[k]); }); return out; }
  function setLang(l) { localStorage.setItem('zx_lang', l); location.reload(); }
  function applyStaticI18n() {
    var lbl = document.getElementById('startmenu-label'); if (lbl) lbl.textContent = T('All apps');
    var si = document.getElementById('start-search-input'); if (si) si.placeholder = T('Search apps');
    document.documentElement.lang = langChoice();
  }

  // ============================================================
  // Window Manager
  // ============================================================
  var winLayer = $('#windows');
  var zTop = 100;
  var wins = {};            // instanceId -> win
  var openByApp = {};       // appId -> instanceId (for singletons)
  var seq = 0;

  // ---------- Application menu bar (real-app feel; in-window on Win/Ubuntu, global top bar on macOS) ----------
  var openDD = null;
  function closeDD() { if (openDD) { openDD.remove(); openDD = null; } }
  function buildMenuBar(container, model) {
    container.innerHTML = '';
    model.forEach(function (menu) {
      var b = el('button', 'menu-btn', menu.label);
      b.addEventListener('click', function (e) {
        e.stopPropagation(); var wasOpen = openDD && openDD._owner === b; closeDD(); if (wasOpen) return;
        var dd = el('div', 'menu-dd'); dd._owner = b;
        (menu.items || []).forEach(function (it) {
          if (it === '---') { dd.appendChild(el('div', 'menu-sep')); return; }
          var mi = el('div', 'menu-item' + (it.disabled ? ' disabled' : ''));
          mi.appendChild(el('span', null, it.label));
          if (it.accel) mi.appendChild(el('span', 'menu-accel', it.accel));
          mi.addEventListener('click', function () { closeDD(); if (!it.disabled && it.action) it.action(); });
          dd.appendChild(mi);
        });
        document.body.appendChild(dd);
        var r = b.getBoundingClientRect(); dd.style.left = r.left + 'px'; dd.style.top = r.bottom + 'px';
        openDD = dd;
      });
      container.appendChild(b);
    });
  }
  function macMenuHost() { var h = document.getElementById('mac-menus'); if (!h) { h = el('div'); h.id = 'mac-menus'; var left = document.getElementById('topbar-left'); if (left) left.appendChild(h); } return h; }
  function macMenuClear() { var h = document.getElementById('mac-menus'); if (h) { h.innerHTML = ''; h.style.display = 'none'; } }
  function applyWinMenus(w) {
    var hasMenus = w._menuModel && w._menuModel.length;
    if (document.body.dataset.os === 'mac') {
      if (w.menubar) w.menubar.style.display = 'none';
      if (w.root.classList.contains('focused')) { if (hasMenus) { var h = macMenuHost(); buildMenuBar(h, w._menuModel); h.style.display = 'flex'; } else macMenuClear(); }
    } else {
      macMenuClear();
      if (w.menubar) { if (hasMenus) { buildMenuBar(w.menubar, w._menuModel); w.menubar.style.display = 'flex'; } else w.menubar.style.display = 'none'; }
    }
  }

  function focusWin(w) {
    Object.keys(wins).forEach(function (k) { wins[k].root.classList.remove('focused'); });
    w.root.classList.add('focused');
    w.root.style.zIndex = ++zTop;
    w.minimized = false; w.root.classList.remove('minimized');
    var nm = document.getElementById('tb-appname'); if (nm) nm.textContent = w._appTitle || w.titleEl.textContent || 'Desktop';
    // macOS shows the focused window's menus in the global top bar — swap them on focus.
    // On Windows/Ubuntu the in-window menu bar is built once (in setMenus) and must NOT be
    // rebuilt here, or a click on a menu button would detach the button before its action fires.
    if (document.body.dataset.os === 'mac') applyWinMenus(w);
    syncTaskbar();
    saveSession();
  }

  function makeWindow(spec) {
    // spec: {appId, title, iconSvg, w, h, onMount(body,win), onClose(win)}
    var id = 'w' + (++seq);
    var root = el('div', 'window');
    root.style.width = (spec.w || 720) + 'px';
    root.style.height = (spec.h || 520) + 'px';
    var offset = (Object.keys(wins).length % 6) * 28;
    root.style.left = Math.max(20, (window.innerWidth - (spec.w || 720)) / 2 + offset) + 'px';
    root.style.top = Math.max(20, (window.innerHeight - (spec.h || 520)) / 2 - 30 + offset) + 'px';

    var bar = el('div', 'titlebar');
    var ticon = el('div', 't-icon', spec.iconSvg || '');
    var title = el('div', 't-title', spec.title || 'App');
    var ctrls = el('div', 'win-controls');
    var bMin = el('button', 'min', "<span class='g'></span>"); bMin.title = T('Minimize');
    var bMax = el('button', 'max', "<span class='g'></span>"); bMax.title = T('Maximize');
    var bClose = el('button', 'close', "<span class='g'></span>"); bClose.title = T('Close');
    ctrls.appendChild(bMin); ctrls.appendChild(bMax); ctrls.appendChild(bClose);
    bar.appendChild(ticon); bar.appendChild(title); bar.appendChild(ctrls);

    var menubar = el('div', 'menubar'); menubar.style.display = 'none';
    var body = el('div', 'win-body');
    root.appendChild(bar); root.appendChild(menubar); root.appendChild(body);
    ['n','s','e','w','ne','nw','se','sw'].forEach(function (d) { root.appendChild(el('div', 'rsz ' + d)); });

    var w = { id: id, appId: spec.appId, root: root, body: body, menubar: menubar, titleEl: title, minimized: false, maximized: false, prev: null, onClose: spec.onClose, cleanup: [] };
    w.setMenus = function (model) { w._menuModel = model; applyWinMenus(w); };
    wins[id] = w;
    winLayer.appendChild(root);

    root.addEventListener('mousedown', function () { focusWin(w); });
    bMin.addEventListener('click', function (e) { e.stopPropagation(); w.minimized = true; root.classList.add('minimized'); syncTaskbar(); saveSession(); });
    bMax.addEventListener('click', function (e) { e.stopPropagation(); toggleMax(w); });
    bClose.addEventListener('click', function (e) { e.stopPropagation(); closeWin(w); });
    bar.addEventListener('dblclick', function () { toggleMax(w); });
    enableDrag(w, bar);
    enableResize(w);

    if (spec.onMount) spec.onMount(body, w);
    focusWin(w);
    syncTaskbar();
    return w;
  }

  function toggleMax(w) {
    if (w.maximized) {
      w.root.classList.remove('maximized');
      if (w.prev) { w.root.style.left = w.prev.l; w.root.style.top = w.prev.t; w.root.style.width = w.prev.w; w.root.style.height = w.prev.h; }
      w.maximized = false;
    } else {
      w.prev = { l: w.root.style.left, t: w.root.style.top, w: w.root.style.width, h: w.root.style.height };
      w.root.classList.add('maximized');
      var os = document.body.dataset.os;
      var tb = os === 'ubuntu' ? 28 : (os === 'mac' ? 26 : 0);
      var bb = os === 'win' ? 48 : (os === 'mac' ? 88 : 0);
      var lb = os === 'ubuntu' ? 64 : 0;
      w.root.style.left = lb + 'px'; w.root.style.top = tb + 'px';
      w.root.style.width = (window.innerWidth - lb) + 'px';
      w.root.style.height = (window.innerHeight - tb - bb) + 'px';
      w.maximized = true;
    }
    saveSession();
  }

  function closeWin(w) {
    try { if (w.onClose) w.onClose(w); } catch (e) {}
    w.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
    var wasFocused = w.root.classList.contains('focused');
    w.root.remove();
    delete wins[w.id];
    Object.keys(openByApp).forEach(function (a) { if (openByApp[a] === w.id) delete openByApp[a]; });
    closeDD();
    if (document.body.dataset.os === 'mac' && wasFocused) macMenuClear();
    syncTaskbar();
    saveSession();
  }

  function enableDrag(w, handle) {
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('.win-controls')) return;
      if (w.maximized) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      var sl = parseInt(w.root.style.left, 10), st = parseInt(w.root.style.top, 10);
      function mv(ev) {
        w.root.style.left = Math.max(-40, sl + (ev.clientX - sx)) + 'px';
        w.root.style.top = Math.max(0, st + (ev.clientY - sy)) + 'px';
      }
      function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); saveSession(); }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
  }

  function enableResize(w) {
    Array.prototype.forEach.call(w.root.querySelectorAll('.rsz'), function (h) {
      h.addEventListener('mousedown', function (e) {
        if (w.maximized) return;
        e.preventDefault(); e.stopPropagation();
        var dir = h.className.replace('rsz ', '');
        var sx = e.clientX, sy = e.clientY;
        var sl = parseInt(w.root.style.left, 10), st = parseInt(w.root.style.top, 10);
        var sw = w.root.offsetWidth, sh = w.root.offsetHeight;
        function mv(ev) {
          var dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (dir.indexOf('e') !== -1) w.root.style.width = Math.max(320, sw + dx) + 'px';
          if (dir.indexOf('s') !== -1) w.root.style.height = Math.max(200, sh + dy) + 'px';
          if (dir.indexOf('w') !== -1) { var nw = Math.max(320, sw - dx); w.root.style.width = nw + 'px'; w.root.style.left = (sl + (sw - nw)) + 'px'; }
          if (dir.indexOf('n') !== -1) { var nh = Math.max(200, sh - dy); w.root.style.height = nh + 'px'; w.root.style.top = (st + (sh - nh)) + 'px'; }
        }
        function up() { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); saveSession(); }
        document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
      });
    });
  }

  // ============================================================
  // Taskbar + Start menu
  // ============================================================
  var taskApps = $('#taskbar-apps');
  function syncTaskbar() {
    taskApps.innerHTML = '';
    // pinned: Zamolxis always; plus any running window not already pinned
    var shown = {};
    var order = [];
    order.push({ appId: 'zamolxis', iconSvg: ICON.zamolxis, title: AGENT_NAME });
    shown.zamolxis = true;
    Object.keys(wins).forEach(function (k) {
      var w = wins[k];
      if (!shown[w.appId]) { shown[w.appId] = true; order.push({ appId: w.appId, iconSvg: w._iconSvg || ICON.agent, title: w._appTitle || w.titleEl.textContent }); }
    });
    order.forEach(function (o) {
      var btn = el('button', 'tb-app', o.iconSvg);
      btn.title = o.title;
      var running = Object.keys(wins).some(function (k) { return wins[k].appId === o.appId; });
      var focused = Object.keys(wins).some(function (k) { return wins[k].appId === o.appId && wins[k].root.classList.contains('focused') && !wins[k].minimized; });
      if (focused) btn.classList.add('active'); else if (running) btn.classList.add('running');
      btn.addEventListener('click', function () { taskbarClick(o.appId); });
      taskApps.appendChild(btn);
    });
  }
  function taskbarClick(appId) {
    var inst = Object.keys(wins).filter(function (k) { return wins[k].appId === appId; });
    if (!inst.length) { launchApp(appId); return; }
    var w = wins[inst[0]];
    if (w.root.classList.contains('focused') && !w.minimized) { w.minimized = true; w.root.classList.add('minimized'); syncTaskbar(); }
    else focusWin(w);
  }

  var startMenu = $('#startmenu');
  function toggleStart() { startMenu.classList.toggle('hidden'); if (!startMenu.classList.contains('hidden')) { renderStart(); $('#start-search-input').value = ''; $('#start-search-input').focus(); } }
  function closeStart() { startMenu.classList.add('hidden'); }
  function smRow(a) {
    var r = el('div', 'sm-row'); r.appendChild(el('div', 'ico', a.iconSvg)); r.appendChild(el('div', 'label', a.name)); r.title = a.name;
    r.addEventListener('click', function () { closeStart(); launchApp(a.id); });
    return r;
  }
  function smTile(a) {
    var t = el('div', 'sm-tile'); t.appendChild(el('div', 'ico', a.iconSvg)); t.appendChild(el('div', 'label', a.name)); t.title = a.name;
    t.addEventListener('click', function () { closeStart(); launchApp(a.id); });
    return t;
  }
  // Windows-10-style: left = app list grouped by category, right = tiles.
  function renderStart(filter) {
    var wrap = $('#startmenu-apps'); wrap.innerHTML = '';
    var list = appList();
    var cols = el('div', 'sm-cols'); var left = el('div', 'sm-list'); var right = el('div', 'sm-tiles');
    cols.appendChild(left); cols.appendChild(right); wrap.appendChild(cols);
    if (filter) {
      var f = filter.toLowerCase(); list = list.filter(function (a) { return a.name.toLowerCase().indexOf(f) !== -1; });
      if (!list.length) { left.appendChild(el('div', 'empty', T('No apps match.'))); return; }
      list.forEach(function (a) { left.appendChild(smRow(a)); right.appendChild(smTile(a)); });
      return;
    }
    var byCat = {}; list.forEach(function (a) { var c = a.cat || 'Utilities'; (byCat[c] = byCat[c] || []).push(a); });
    var cats = CAT_ORDER.filter(function (c) { return byCat[c]; });
    Object.keys(byCat).forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
    cats.forEach(function (c) {
      left.appendChild(el('div', 'sm-cat', T(c)));
      byCat[c].forEach(function (a) { left.appendChild(smRow(a)); });
    });
    list.forEach(function (a) { right.appendChild(smTile(a)); });
  }

  // ============================================================
  // App registry (Zamolxis default + Settings + New Agent + agents)
  // ============================================================
  var agents = []; // from /api/agents

  // Catalog of bundled desktop apps. Each is ALSO a skill (skill slug) so the same capability
  // is available in the classic UI and to the agent. `kind:'native'` = client app; `kind:'agent'`
  // = opens a task-scoped chat to Zamolxis, which has the skill + shell tools to perform it.
  var CATALOG = [
    { id: 'files', name: 'Files', iconSvg: ICON.files, cat: 'Utilities', skill: 'file-manager', kind: 'native' },
    { id: 'texteditor', name: 'Text Editor', iconSvg: ICON.editor, cat: 'Utilities', skill: 'text-editor', kind: 'native' },
    { id: 'calculator', name: 'Calculator', iconSvg: ICON.calc, cat: 'Utilities', skill: 'calculator', kind: 'native' },
    { id: 'imageviewer', name: 'Image Viewer', iconSvg: ICON.image, cat: 'Media', skill: 'image-viewer', kind: 'native' },
    { id: 'mediaplayer', name: 'Media Player', iconSvg: ICON.film, cat: 'Media', skill: 'video-player', kind: 'native' },
    { id: 'ebook', name: 'Ebook Reader', iconSvg: ICON.book, cat: 'Media', skill: 'ebook-reader', kind: 'native' },
    { id: 'pdf', name: 'PDF', iconSvg: ICON.pdf, cat: 'Office', skill: 'pdf-tools', kind: 'native' },
    { id: 'word', name: 'Word', iconSvg: ICON.doc, cat: 'Office', skill: 'document-viewer', kind: 'native' },
    { id: 'excel', name: 'Excel', iconSvg: ICON.sheet, cat: 'Office', skill: 'spreadsheet-viewer', kind: 'native' },
    { id: 'outlook', name: 'Outlook', iconSvg: ICON.mail, cat: 'Office', skill: 'outlook-desktop', kind: 'native' },
    { id: 'notes', name: 'Notes', iconSvg: ICON.notebook, cat: 'Office', skill: 'onenote-notes', kind: 'native' },
    { id: 'database', name: 'Database', iconSvg: ICON.db, cat: 'Utilities', skill: 'sql-databases', kind: 'native' },
    { id: 'history', name: 'History', iconSvg: ICON.hist, cat: 'Utilities', skill: 'browser-history', kind: 'native' },
    { id: 'sftp', name: 'SFTP Client', iconSvg: ICON.net, cat: 'Network', skill: 'sftp-client', kind: 'native' },
    { id: 'telnet', name: 'Telnet', iconSvg: ICON.term, cat: 'Network', skill: 'telnet-client', kind: 'native' },
    { id: 'messages', name: 'Messages', iconSvg: ICON.chat, cat: 'Communication', skill: 'chat-clients', kind: 'native' }
  ];
  var CAT_ORDER = ['System', 'Office', 'Media', 'Network', 'Communication', 'Utilities', 'Agents'];
  function builtinApps() {
    return [
      { id: 'zamolxis', name: AGENT_NAME, iconSvg: ICON.zamolxis, kind: 'builtin', cat: 'System' },
      { id: 'settings', name: T('Settings'), iconSvg: ICON.settings, kind: 'builtin', cat: 'System' },
      { id: 'newagent', name: T('New Agent'), iconSvg: ICON.newagent, kind: 'builtin', cat: 'System' },
      { id: 'help', name: T('Help'), iconSvg: ICON.help, kind: 'builtin', cat: 'System' }
    ];
  }
  function appList() {
    var out = builtinApps();
    CATALOG.forEach(function (a) { out.push({ id: a.id, name: T(a.name), iconSvg: a.iconSvg, kind: a.kind, cat: a.cat, skill: a.skill, baseName: a.name }); });
    agents.forEach(function (a) {
      out.push({ id: 'agent:' + a.name, name: a.label || a.name, iconSvg: agentIconSvg(a.label || a.name), kind: 'agent', cat: 'Agents', agent: a });
    });
    return out;
  }
  function catalogById(id) { for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i]; return null; }
  function appById(id) { var l = appList(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }

  // ---------- session persistence (open windows + geometry + state) ----------
  function saveSession() {
    try {
      var arr = Object.keys(wins).map(function (k) {
        var w = wins[k];
        var g = (w.maximized && w.prev) ? w.prev : { l: w.root.style.left, t: w.root.style.top, w: w.root.style.width, h: w.root.style.height };
        return { appId: w.appId, left: g.l, top: g.t, width: g.w, height: g.h, max: !!w.maximized, min: !!w.minimized, z: parseInt(w.root.style.zIndex, 10) || 100 };
      });
      arr.sort(function (a, b) { return a.z - b.z; });
      localStorage.setItem('zx_session', JSON.stringify(arr));
    } catch (e) {}
  }
  function restoreSession() {
    var arr = [];
    try { arr = JSON.parse(localStorage.getItem('zx_session') || '[]'); } catch (e) {}
    if (!arr.length) return false;
    arr.forEach(function (g) { launchApp(g.appId, g); });
    return Object.keys(wins).length > 0;
  }

  function launchApp(appId, geom) {
    var app = appById(appId);
    if (!app) return null;
    // singleton: focus if already open
    if (openByApp[appId] && wins[openByApp[appId]]) { focusWin(wins[openByApp[appId]]); return wins[openByApp[appId]]; }
    var spec;
    if (appId === 'zamolxis') spec = { appId: appId, title: AGENT_NAME, iconSvg: ICON.zamolxis, w: 460, h: 620, onMount: mountChat };
    else if (appId === 'settings') spec = { appId: appId, title: T('Settings'), iconSvg: ICON.settings, w: 620, h: 520, onMount: mountSettings };
    else if (appId === 'newagent') spec = { appId: appId, title: T('New Agent'), iconSvg: ICON.newagent, w: 460, h: 480, onMount: mountNewAgent };
    else if (appId === 'help') spec = { appId: appId, title: T('Help'), iconSvg: ICON.help, w: 720, h: 600, onMount: mountHelp };
    else if (catalogById(appId)) {
      var ca = catalogById(appId);
      if (appId === 'files') spec = { appId: appId, title: T('Files'), iconSvg: ICON.files, w: 760, h: 560, onMount: mountFiles };
      else if (appId === 'texteditor') spec = { appId: appId, title: T('Text Editor'), iconSvg: ICON.editor, w: 720, h: 560, onMount: function (b, w) { mountTextEditor(b, w, null); } };
      else if (appId === 'calculator') spec = { appId: appId, title: T('Calculator'), iconSvg: ICON.calc, w: 300, h: 430, onMount: mountCalculator };
      else if (appId === 'sftp') spec = { appId: appId, title: T('SFTP Client'), iconSvg: ICON.net, w: 820, h: 600, onMount: mountSftp };
      else if (appId === 'telnet') spec = { appId: appId, title: T('Telnet'), iconSvg: ICON.term, w: 720, h: 520, onMount: mountTelnet };
      else if (appId === 'messages') spec = { appId: appId, title: T('Messages'), iconSvg: ICON.chat, w: 720, h: 560, onMount: mountMessages };
      else if (appId === 'outlook') spec = { appId: appId, title: T('Outlook'), iconSvg: ICON.mail, w: 860, h: 620, onMount: mountOutlook };
      else if (appId === 'notes') spec = { appId: appId, title: T('Notes'), iconSvg: ICON.notebook, w: 820, h: 600, onMount: mountNotes };
      else if (appId === 'database') spec = { appId: appId, title: T('Database'), iconSvg: ICON.db, w: 880, h: 620, onMount: mountDatabase };
      else if (appId === 'history') spec = { appId: appId, title: T('History'), iconSvg: ICON.hist, w: 760, h: 600, onMount: mountBrowserHistory };
      else spec = { appId: appId, title: T(ca.name), iconSvg: ca.iconSvg, w: 780, h: 620, onMount: function (b, w) { mountEmptyViewer(b, w, ca); } };
    }
    else if (app.kind === 'agent') spec = { appId: appId, title: app.name, iconSvg: app.iconSvg || agentIconSvg(app.name), w: 520, h: 560, onMount: function (b, w) { mountAgent(b, w, app.agent); } };
    if (!spec) return null;
    var w = makeWindow(spec);
    w._iconSvg = spec.iconSvg; w._appTitle = spec.title;
    openByApp[appId] = w.id;
    if (geom) {
      if (geom.left) w.root.style.left = geom.left;
      if (geom.top) w.root.style.top = geom.top;
      if (geom.width) w.root.style.width = geom.width;
      if (geom.height) w.root.style.height = geom.height;
      if (geom.max) toggleMax(w);
      if (geom.min) { w.minimized = true; w.root.classList.add('minimized'); }
    }
    syncTaskbar();
    saveSession();
    return w;
  }

  // ---------- chat transcript persistence (survives reload / interface switch) ----------
  function loadChatLog(key) { try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; } }
  function pushChatLog(key, rec) { try { var a = loadChatLog(key); a.push(rec); if (a.length > 300) a = a.slice(a.length - 300); localStorage.setItem(key, JSON.stringify(a)); } catch (e) {} }

  // ---------- model/route options: Auto, Local, Free cloud, every AUTHENTICATED provider, Claude ----------
  function fetchModelOpts() {
    return Promise.all([
      api('/api/providers').catch(function () { return { providers: [] }; }),
      api('/api/status').catch(function () { return {}; })
    ]).then(function (res) {
      var provs = (res[0] && res[0].providers) || [];
      var st = res[1] || {};
      var opts = [['auto', T('Auto (smartest decides)')]];
      if (st.models && st.models.local) opts.push(['local', 'Local (' + st.models.local + ')']);
      opts.push(['freecloud', T('Free cloud (rotates free providers)')]);
      provs.filter(function (p) { return p.configured; }).forEach(function (p) { opts.push([p.id, p.label + (p.kind === 'free' ? ' · free' : '')]); });
      opts.push(['claude', T('Claude (subscription)')]);
      return opts;
    });
  }
  function fillSelect(sel, opts, cur) {
    sel.innerHTML = '';
    opts.forEach(function (o) { var op = el('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
    if (cur && cur !== 'auto' && !opts.some(function (o) { return o[0] === cur; })) { var op = el('option'); op.value = cur; op.textContent = cur + ' (not configured)'; sel.appendChild(op); }
    sel.value = cur || 'auto';
  }

  // ---------- App: Chat (Zamolxis main chat) ----------
  function mountChat(body, win) {
    var cid = localStorage.getItem('zx_cid_main');
    if (!cid) { cid = uuid(); localStorage.setItem('zx_cid_main', cid); }
    buildChat(body, win, cid, { route: true });
  }

  function buildChat(body, win, cid, opts) {
    body.style.padding = '0';
    var logKey = 'zx_log_' + cid;
    var wrap = el('div', 'chat');
    var bar = el('div', 'chat-bar');
    bar.innerHTML = "<span>" + T('Route') + "</span>";
    var sel = el('select');
    var savedRoute = localStorage.getItem('zx_route_' + cid) || localStorage.getItem('zx_default_route') || 'auto';
    fillSelect(sel, [['auto', 'Auto']], savedRoute);
    fetchModelOpts().then(function (opts) { fillSelect(sel, opts, savedRoute); });
    sel.addEventListener('change', function () { localStorage.setItem('zx_route_' + cid, sel.value); });
    var stat = el('span'); stat.style.marginLeft = 'auto'; stat.textContent = T('connecting...');
    if (opts && opts.route) bar.appendChild(sel);
    bar.appendChild(stat);

    var log = el('div', 'chat-log');
    var chips = el('div'); chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:0 10px';
    var inputRow = el('div', 'chat-input');
    var attach = el('button'); attach.textContent = '📎'; attach.title = T('Attach files'); attach.style.cssText = 'padding:0 12px;background:#e5e5e5;border:0;border-radius:8px;cursor:pointer';
    var fileIn = el('input'); fileIn.type = 'file'; fileIn.multiple = true; fileIn.style.display = 'none';
    var ta = el('textarea'); ta.placeholder = (opts && opts.placeholder ? opts.placeholder : T('Message') + ' ' + AGENT_NAME) + '...';
    var send = el('button'); send.textContent = T('Send');
    inputRow.appendChild(attach); inputRow.appendChild(ta); inputRow.appendChild(send);
    wrap.appendChild(bar); wrap.appendChild(log); wrap.appendChild(chips); wrap.appendChild(inputRow);
    body.appendChild(wrap); body.appendChild(fileIn);
    var pending = [];
    function renderChips() { chips.innerHTML = ''; pending.forEach(function (f, i) { var c = el('span'); c.style.cssText = 'background:#e5e5e5;color:#222;border-radius:10px;padding:2px 8px;font-size:12px;display:flex;gap:6px;align-items:center'; c.appendChild(document.createTextNode('📎 ' + f.name)); var x = el('span'); x.textContent = '✕'; x.style.cssText = 'cursor:pointer;color:#b00'; x.addEventListener('click', function () { pending.splice(i, 1); renderChips(); }); c.appendChild(x); chips.appendChild(c); }); }
    attach.addEventListener('click', function () { fileIn.click(); });
    fileIn.addEventListener('change', function () { [].slice.call(fileIn.files || []).forEach(function (f) { if (f.size > 20 * 1024 * 1024) return; var rd = new FileReader(); rd.onload = function () { var s = String(rd.result || ''); var i = s.indexOf(','); pending.push({ name: f.name, size: f.size, b64: i >= 0 ? s.slice(i + 1) : s }); renderChips(); }; rd.readAsDataURL(f); }); fileIn.value = ''; });

    function addMsg(who, text, cls, via, persist) {
      var m = el('div', 'msg ' + cls);
      m.appendChild(el('div', 'who', who + (via ? ' · via ' + via : '')));
      var c = el('div'); c.textContent = text; m.appendChild(c);
      log.appendChild(m); log.scrollTop = log.scrollHeight;
      if (persist !== false) pushChatLog(logKey, { who: who, text: text, cls: cls, via: via });
      return c;
    }
    // restore the saved transcript for this conversation
    var _hist = loadChatLog(logKey);
    _hist.forEach(function (r) { addMsg(r.who, r.text, r.cls, r.via, false); });
    if (!_hist.length && opts && opts.intro) addMsg(AGENT_NAME, opts.intro, 'bot', null, false);

    // WebSocket
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var sock, streamEl = null;
    function connect() {
      sock = new WebSocket(proto + '://' + location.host + '/?cid=' + encodeURIComponent(cid) + '&token=');
      sock.onopen = function () { stat.textContent = '● ' + T('connected'); stat.style.color = '#2e9e3f'; };
      sock.onclose = function () { stat.textContent = '● ' + T('reconnecting'); stat.style.color = '#d13438'; setTimeout(function () { if (!win.closed) connect(); }, 2500); };
      sock.onerror = function () { stat.textContent = '● ' + T('error'); stat.style.color = '#d13438'; };
      sock.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'status') return;
        if (m.type === 'chunk') { if (!streamEl) streamEl = addMsg(AGENT_NAME, '', 'bot', null, false); streamEl.textContent += m.text; log.scrollTop = log.scrollHeight; return; }
        if (m.type === 'reply') { if (streamEl) { streamEl.textContent = m.text; streamEl = null; pushChatLog(logKey, { who: AGENT_NAME, text: m.text, cls: 'bot' }); } else { addMsg(AGENT_NAME, m.text, 'bot'); } stat.textContent = '● ' + T('connected'); }
      };
    }
    connect();
    win.cleanup.push(function () { win.closed = true; try { sock.close(); } catch (e) {} });

    function doSend() {
      var t = ta.value.trim(); var files = pending.slice();
      if ((!t && !files.length) || !sock || sock.readyState !== WebSocket.OPEN) return;
      var shown = t + (files.length ? ((t ? '\n' : '') + files.map(function (f) { return '📎 ' + f.name; }).join('\n')) : '');
      addMsg(T('You'), shown || '(file)', 'user'); ta.value = ''; streamEl = null; stat.textContent = T('thinking...');
      if (!files.length) { sock.send(JSON.stringify({ text: t, route: sel.value })); return; }
      pending = []; renderChips();
      // Text-readable files: inject content inline (any model can read → route by your choice). Others (images/PDF/Office): upload + Claude tools.
      var TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|html?|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|zsh|ps1|bat|sql|ini|toml|cfg|conf|log|env|tex|rst|gradle|properties|dockerfile|makefile|gitignore)$/i;
      function b64text(b) { try { return decodeURIComponent(escape(atob(b))); } catch (e) { try { return atob(b); } catch (e2) { return ''; } } }
      var IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
      function imgMime(n) { var e = (n.split('.').pop() || '').toLowerCase(); return e === 'png' ? 'image/png' : e === 'gif' ? 'image/gif' : e === 'webp' ? 'image/webp' : e === 'bmp' ? 'image/bmp' : 'image/jpeg'; }
      var inj = [], upl = [], imgs = [];
      files.forEach(function (f) {
        if (IMG_EXT.test(f.name) && f.size <= 4 * 1024 * 1024) imgs.push('data:' + imgMime(f.name) + ';base64,' + f.b64); // inline for vision (Gemini)
        var tx = (TEXT_EXT.test(f.name) && f.size <= 400000) ? b64text(f.b64) : null;
        if (tx !== null) { var clip = tx.length > 100000 ? (tx.slice(0, 100000) + '\n...[truncated]') : tx; inj.push('----- ' + f.name + ' -----\n' + clip + '\n-----'); } else { upl.push(f); }
      });
      var base = (t || '') + (inj.length ? ((t ? '\n\n' : '') + inj.join('\n\n')) : '');
      var imgsP = imgs.length ? imgs : undefined;
      if (!upl.length) { sock.send(JSON.stringify({ text: base || '(see attached content)', route: sel.value, images: imgsP })); return; }
      stat.textContent = T('uploading...');
      Promise.all(upl.map(function (f) { return api('/api/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: cid, name: f.name, contentB64: f.b64 }) }).then(function (d) { return d || null; }).catch(function () { return null; }); })).then(function (rs) {
        var docTexts = [], paths = [], hasBinary = false;
        rs.filter(Boolean).forEach(function (x) { if (x.text) { docTexts.push('----- ' + (x.name || 'file') + ' -----\n' + x.text + '\n-----'); } else if (x.path) { paths.push(x.path); if (!IMG_EXT.test(x.name || '')) hasBinary = true; } });
        var body2 = base + (docTexts.length ? ((base ? '\n\n' : '') + docTexts.join('\n\n')) : '');
        var note = body2 + ((body2 && paths.length) ? '\n\n' : '') + (paths.length ? ('Attached file(s) - read them with your tools to answer:\n' + paths.map(function (p) { return '- ' + p; }).join('\n')) : '');
        stat.textContent = T('thinking...'); sock.send(JSON.stringify({ text: note, route: hasBinary ? 'claude' : sel.value, images: imgsP }));
      });
    }
    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    if (win.setMenus) win.setMenus([
      { label: T('File'), items: [ { label: T('Clear conversation'), action: function () { if (confirm(T('Clear conversation') + '?')) { log.innerHTML = ''; try { localStorage.removeItem(logKey); } catch (e) {} api('/api/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid: cid }) }).catch(function () {}); } } } ] },
      { label: T('Help'), items: [ { label: T('Help & Guide'), action: function () { launchApp('help'); } } ] }
    ]);
    setTimeout(function () { ta.focus(); }, 50);
  }

  // ---------- App: Settings (tabbed, wired to the real backend) ----------
  function osName(o) { return o === 'mac' ? 'macOS' : (o === 'ubuntu' ? 'Ubuntu' : 'Windows'); }
  function postSettings(patch) { return api('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }); }
  function restartZam(btn, status) { if (btn) btn.disabled = true; if (status) status.textContent = T('Restarting...'); api('/api/restart', { method: 'POST' }).then(function () { setTimeout(function () { location.reload(); }, 4500); }).catch(function () { if (btn) btn.disabled = false; if (status) status.textContent = T('Failed.'); }); }
  function fld(labelTxt, node, hint) { var f = el('div', 'field'); f.appendChild(el('label', null, labelTxt)); if (hint) f.appendChild(el('div', 'hint', hint)); f.appendChild(node); return f; }
  function inp(val) { var i = el('input', 'inp'); i.style.width = '100%'; i.value = (val == null ? '' : val); return i; }

  var settingsRender = null;
  function mountSettings(body, win) {
    body.style.padding = '0';
    var state = { tab: 'appearance' };
    var wrap = el('div', 'settings-wrap');
    var nav = el('div', 'set-nav');
    var pane = el('div', 'set-pane');
    wrap.appendChild(nav); wrap.appendChild(pane); body.appendChild(wrap);
    var tabs = [['appearance', T('Appearance')], ['engine', T('Engine')], ['providers', T('Providers')], ['channels', T('Channels')], ['skills', T('Skills')], ['system', T('System')]];
    function renderNav() { nav.innerHTML = ''; tabs.forEach(function (t) { var b = el('button', state.tab === t[0] ? 'active' : null, t[1]); b.addEventListener('click', function () { state.tab = t[0]; renderNav(); renderTab(); }); nav.appendChild(b); }); }
    function renderTab() {
      pane.innerHTML = '';
      if (state.tab === 'appearance') tabAppearance(pane);
      else if (state.tab === 'engine') tabEngine(pane);
      else if (state.tab === 'providers') tabProviders(pane);
      else if (state.tab === 'channels') tabChannels(pane);
      else if (state.tab === 'skills') tabSkills(pane);
      else tabSystem(pane);
    }
    settingsRender = function () { renderTab(); };
    win.cleanup.push(function () { settingsRender = null; });
    renderNav(); renderTab();
  }
  function rerenderSettings() { if (settingsRender) settingsRender(); }

  function tabAppearance(pane) {
    var t = applyTheme();
    var f = el('div', 'field');
    f.appendChild(el('label', null, T('Desktop style')));
    f.appendChild(el('div', 'hint', 'Auto follows your OS (detected: ' + osName(t.effective) + '). Override below.'));
    var seg = el('div', 'seg');
    [['auto', 'Auto'], ['win', 'Windows 11'], ['mac', 'macOS'], ['ubuntu', 'Ubuntu'], ['classic', 'Classic']].forEach(function (o) {
      var b = el('button', t.choice === o[0] ? 'active' : null, T(o[1]));
      b.addEventListener('click', function () { if (o[0] === 'classic') { location.href = '/classic'; } else { setTheme(o[0]); } });
      seg.appendChild(b);
    });
    f.appendChild(seg); pane.appendChild(f);
    pane.appendChild(el('div', 'hint', '"Classic" opens the previous stable Zamolxis interface (the last stable version), kept as a fourth option.'));

    var mc = modeChoice();
    var f2 = el('div', 'field');
    f2.appendChild(el('label', null, T('Appearance mode')));
    f2.appendChild(el('div', 'hint', 'Auto follows your system light/dark preference (now: ' + resolveMode(mc) + ').'));
    var seg2 = el('div', 'seg');
    [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].forEach(function (o) {
      var b = el('button', mc === o[0] ? 'active' : null, T(o[1]));
      b.addEventListener('click', function () { setMode(o[0]); });
      seg2.appendChild(b);
    });
    f2.appendChild(seg2); pane.appendChild(f2);

    var lc = langChoice();
    var f3 = el('div', 'field');
    f3.appendChild(el('label', null, T('Language')));
    f3.appendChild(el('div', 'hint', T('Choose the interface language. Default is English; untranslated labels stay in English.')));
    var seg3 = el('div', 'seg');
    LANGS.forEach(function (o) {
      var b = el('button', lc === o[0] ? 'active' : null, o[1]);
      b.addEventListener('click', function () { if (o[0] !== langChoice()) setLang(o[0]); });
      seg3.appendChild(b);
    });
    f3.appendChild(seg3); pane.appendChild(f3);
  }

  function tabEngine(pane) {
    pane.appendChild(el('div', 'hint', T('Loading...')));
    api('/api/settings').then(function (s) {
      pane.innerHTML = '';
      var live = s.live || {};
      var name = inp(live.agentName);
      var tz = inp(live.timezone); tz.placeholder = 'e.g. Europe/Bucharest';
      // Unified model list from the backend snapshot: Claude variants + 'local' + every configured provider.
      function mlabel(v) { return v === '' ? 'Claude (default)' : v === 'local' ? 'Local' : v === 'freecloud' ? 'Free cloud' : v; }
      var modelOpts = (((s.meta && s.meta.models) || ['']).map(function (v) { return [v, mlabel(v)]; }));
      function modelSel(cur) { var sl = el('select', 'inp'); sl.style.width = '100%'; fillSelect(sl, modelOpts, cur || ''); return sl; }
      var model = modelSel(live.model);
      var fast = modelSel(live.fastModel);
      var smart = modelSel(live.smartModel);
      var perm = el('select', 'inp'); perm.style.width = '100%';
      ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'].forEach(function (m) { var o = el('option'); o.value = m; o.textContent = m; if (live.permissionMode === m) o.selected = true; perm.appendChild(o); });
      var turns = inp(live.maxTurns); turns.type = 'number';
      var conc = inp(live.maxConcurrent); conc.type = 'number';
      var tmo = inp(live.turnTimeoutSeconds); tmo.type = 'number'; tmo.min = '10';
      var routing = el('button', 'switch' + (live.localRouting !== 'off' ? ' on' : ''), "<span class='knob'></span>");
      routing.addEventListener('click', function () { routing.classList.toggle('on'); });
      var sys = el('textarea', 'inp'); sys.style.cssText = 'width:100%;height:80px'; sys.value = live.systemPromptAppend || '';

      pane.appendChild(el('div', 'hint', T('Each model can be a Claude variant, Local, or any authenticated free provider. Model = answers your chats · Fast = simple turns · Smartest = hard turns / final fallback. "Claude (default)" keeps Claude as the rescue tier.')));
      pane.appendChild(fld(T('Model (answers your chats)'), model));
      pane.appendChild(fld(T('Fast model (simple turns)'), fast));
      pane.appendChild(fld(T('Smartest model (hard turns / final fallback)'), smart));
      pane.appendChild(fld(T('Assistant name'), name));
      pane.appendChild(fld(T('Timezone'), tz, 'IANA name used for time-aware replies and schedules (blank = server default).'));
      pane.appendChild(fld(T('Permission mode'), perm));
      var row = el('div', 'row2'); var c1 = el('div'); c1.style.flex = '1'; c1.appendChild(fld(T('Max turns'), turns)); var c2 = el('div'); c2.style.flex = '1'; c2.appendChild(fld(T('Max concurrent'), conc)); row.appendChild(c1); row.appendChild(c2); pane.appendChild(row);
      pane.appendChild(fld(T('Turn timeout (seconds)'), tmo, T('How long a single turn may run before it is stopped. e.g. 3600 = 1 hour, 14400 = 4 hours. Applies live.')));
      var rrow = el('div'); rrow.style.cssText = 'display:flex;align-items:center;gap:8px'; rrow.appendChild(routing); rrow.appendChild(el('span', 'hint', T('Local-model routing (auto / off)'))); pane.appendChild(fld(T('Routing'), rrow));
      pane.appendChild(fld(T('System prompt append'), sys));
      var status = el('span', 'hint'); var save = el('button', 'btn', T('Save'));
      var sr = el('div', 'save-row'); sr.appendChild(save); sr.appendChild(status); pane.appendChild(sr);
      save.addEventListener('click', function () {
        save.disabled = true; status.textContent = T('Saving...');
        postSettings({ live: { agentName: name.value.trim(), timezone: tz.value.trim(), model: model.value, fastModel: fast.value, smartModel: smart.value, permissionMode: perm.value, maxTurns: Number(turns.value) || undefined, maxConcurrent: Number(conc.value) || undefined, turnTimeoutSeconds: Number(tmo.value) || undefined, localRouting: routing.classList.contains('on') ? 'auto' : 'off', systemPromptAppend: sys.value } })
          .then(function (r) { save.disabled = false; status.textContent = T('Saved.') + (r && r.restartRequired ? T(' Some changes need a restart (System tab).') : ''); })
          .catch(function () { save.disabled = false; status.textContent = T('Failed.'); });
      });
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', T('Could not load settings.'))); });
  }

  function tabProviders(pane) {
    pane.appendChild(el('div', 'hint', T('Loading providers...')));
    api('/api/providers').then(function (d) {
      pane.innerHTML = '';
      pane.appendChild(el('div', 'hint', T('Saving a key persists it; it takes effect after a restart (System tab).')));
      (d.providers || []).forEach(function (p) {
        var card = el('div', 'prov');
        var top = el('div', 'top');
        top.appendChild(el('span', 'name', p.label || p.id));
        top.appendChild(el('span', 'tag ' + (p.kind === 'paid' ? 'paid' : 'free'), p.kind || 'free'));
        if (p.configured) top.appendChild(el('span', 'tag ok', T('configured')));
        card.appendChild(top);
        card.appendChild(el('div', 'hint', (p.model || '') + (p.note ? (' — ' + p.note) : '') + (typeof p.used === 'number' ? (' · used ' + p.used + (p.freeDaily ? ('/' + p.freeDaily) : '')) : '')));
        if (p.envKey) {
          var krow = el('div'); krow.style.cssText = 'display:flex;gap:8px;margin-top:8px';
          var key = el('input', 'inp'); key.type = 'password'; key.style.flex = '1';
          key.placeholder = p.configured ? T('•••• set — paste to replace, or Save empty to remove') : T('Paste API key');
          var sv = el('button', 'btn', T('Save')); var st = el('div', 'hint'); st.style.marginTop = '4px';
          krow.appendChild(key); krow.appendChild(sv);
          function clearKey() {
            sv.disabled = true; st.textContent = T('Removing...');
            postSettings({ clearCredentials: [p.envKey] }).then(function () { st.textContent = T('Removed.'); tabProviders(pane); }).catch(function () { sv.disabled = false; st.textContent = T('Failed.'); });
          }
          if (p.configured) { var rm = el('button', 'btn ghost', T('Remove')); rm.addEventListener('click', clearKey); krow.appendChild(rm); }
          card.appendChild(krow); card.appendChild(st);
          sv.addEventListener('click', function () {
            var v = key.value.trim();
            if (!v) { if (p.configured) clearKey(); else st.textContent = T('Enter a key.'); return; }
            sv.disabled = true; st.textContent = T('Saving...'); var cred = {}; cred[p.envKey] = v;
            postSettings({ credentials: cred }).then(function () { sv.disabled = false; key.value = ''; st.textContent = T('Saved.'); tabProviders(pane); }).catch(function () { sv.disabled = false; st.textContent = T('Failed.'); });
          });
        }
        pane.appendChild(card);
      });
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', T('Could not load providers.'))); });
  }

  // Channels setup tab — enable messaging channels + set their credentials (parity with classic).
  function tabChannels(pane) {
    pane.appendChild(el('div', 'hint', T('Loading...')));
    api('/api/settings').then(function (s) {
      pane.innerHTML = '';
      pane.appendChild(el('div', 'hint', T('Enable a channel and add its credentials. Changes take effect after a restart (System tab).')));
      var chMap = s.channels || {}; var creds = s.credentials || []; var list = (s.meta && s.meta.channels) || [];
      list.filter(function (n) { return n !== 'web' && n !== 'cli'; }).forEach(function (name) {
        var card = el('div', 'prov');
        var top = el('div', 'top');
        top.appendChild(el('span', 'name', name));
        var tog = el('button', 'switch' + (chMap[name] ? ' on' : ''), "<span class='knob'></span>");
        tog.addEventListener('click', function () { var want = !tog.classList.contains('on'); tog.classList.toggle('on', want); var patch = { channels: {} }; patch.channels[name] = want; postSettings(patch).catch(function () {}); });
        var sp = el('div'); sp.style.flex = '1'; top.appendChild(sp); top.appendChild(tog);
        card.appendChild(top);
        var fields = creds.filter(function (c) { return c.group === name; });
        if (!fields.length) card.appendChild(el('div', 'hint', 'No credentials needed.'));
        fields.forEach(function (c) {
          var row = el('div'); row.style.cssText = 'display:flex;gap:8px;margin-top:6px;align-items:center';
          var lbl = el('div', 'hint'); lbl.style.cssText = 'flex:0 0 42%'; lbl.textContent = c.label;
          var inpv = el('input', 'inp'); inpv.style.flex = '1';
          if (c.secret) { inpv.type = 'password'; inpv.placeholder = c.set ? '•••• set — paste to replace' : 'paste value'; } else { inpv.value = c.value || ''; }
          var sv = el('button', 'btn ghost', T('Save'));
          sv.addEventListener('click', function () { var v = inpv.value.trim(); var cred = {}; cred[c.key] = v; sv.disabled = true; sv.textContent = '...'; postSettings({ credentials: cred }).then(function () { sv.disabled = false; sv.textContent = T('Saved.'); if (c.secret) inpv.value = ''; }).catch(function () { sv.disabled = false; sv.textContent = T('Failed.'); }); });
          row.appendChild(lbl); row.appendChild(inpv); row.appendChild(sv); card.appendChild(row);
        });
        pane.appendChild(card);
      });
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', T('Could not load settings.'))); });
  }

  function tabSkills(pane) {
    pane.appendChild(el('div', 'hint', T('Loading skills...')));
    api('/api/skills').then(function (arr) {
      pane.innerHTML = '';
      var list = Array.isArray(arr) ? arr : [];
      var search = inp(''); search.placeholder = Tf('Search {n} skills', { n: list.length }); search.style.marginBottom = '10px';
      pane.appendChild(search);
      var box = el('div'); pane.appendChild(box);
      function draw(f) {
        box.innerHTML = ''; var q = (f || '').toLowerCase();
        var shown = list.filter(function (s) { return !q || (s.name + ' ' + (s.description || '')).toLowerCase().indexOf(q) !== -1; });
        if (!shown.length) { box.appendChild(el('div', 'empty', T('No skills match.'))); return; }
        shown.forEach(function (s) {
          var rowEl = el('div', 'skill');
          var meta = el('div', 'meta');
          meta.appendChild(el('div', 'sname', s.name + (s.source === 'external' ? '  ·  external' : '')));
          meta.appendChild(el('div', 'sdesc', (s.description || '').slice(0, 160)));
          rowEl.appendChild(meta);
          if (s.source === 'external') {
            var imp = el('button', 'btn ghost', T('Import')); imp.style.cssText = 'padding:5px 10px;flex:0 0 auto';
            imp.addEventListener('click', function () { imp.disabled = true; api('/api/skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import', slug: s.name }) }).then(function () { s.source = 'own'; draw(search.value); }).catch(function () { imp.disabled = false; }); });
            rowEl.appendChild(imp);
          } else {
            var en = s.enabled !== false;
            var tg = el('button', 'switch' + (en ? ' on' : ''), "<span class='knob'></span>");
            tg.addEventListener('click', function () {
              var want = !tg.classList.contains('on'); tg.classList.toggle('on', want);
              api('/api/skills', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: want ? 'enable' : 'disable', slug: s.name }) }).then(function () { s.enabled = want; }).catch(function () { tg.classList.toggle('on', !want); });
            });
            rowEl.appendChild(tg);
          }
          box.appendChild(rowEl);
        });
      }
      search.addEventListener('input', function () { draw(this.value); });
      draw('');
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', T('Could not load skills.'))); });
  }

  function tabSystem(pane) {
    pane.appendChild(el('div', 'hint', T('Loading...')));
    api('/api/status').then(function (s) {
      pane.innerHTML = '';
      var v = s.version || {}, m = s.models || {}, u = s.update || {};
      function kv(k, val) { var r = el('div'); r.style.cssText = 'display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:13px'; r.appendChild(el('span', null, k)); var b = el('span'); b.style.color = '#555'; b.textContent = val; r.appendChild(b); return r; }
      pane.appendChild(kv(T('Version'), (v.pkg || '?') + ' · build ' + (v.build != null ? v.build : '?') + ' · ' + (v.commit || '')));
      pane.appendChild(kv(T('Primary model'), m.primary || '?'));
      pane.appendChild(kv(T('Fast model'), m.fast || '?'));
      pane.appendChild(kv(T('Local model'), m.local || T('(none)')));
      pane.appendChild(kv(T('Tokens (session)'), String((s.engineTokens && s.engineTokens.session) || 0)));

      // --- Updates: one-click upgrade (pull + build + restart) ---
      pane.appendChild(el('label', null, T('Updates')));
      var ustat = el('div', 'hint');
      function setUStat(behind, branch) {
        ustat.textContent = (behind ? ('⬆ ' + Tf('Update available — {n} new commit(s) on {branch}', { n: behind, branch: branch })) : Tf('Up to date on {branch}.', { branch: branch || '?' }));
      }
      setUStat(u.behind, u.branch);
      pane.appendChild(ustat);
      var upRow = el('div', 'save-row');
      var checkBtn = el('button', 'btn ghost', T('Check for updates'));
      var upBtn = el('button', 'btn', u.behind ? Tf('Upgrade now ({n})', { n: u.behind }) : T('Upgrade'));
      var upMsg = el('span', 'hint');
      upRow.appendChild(checkBtn); upRow.appendChild(upBtn); upRow.appendChild(upMsg); pane.appendChild(upRow);

      checkBtn.addEventListener('click', function () {
        checkBtn.disabled = true; upMsg.textContent = T('Checking...');
        api('/api/checkupdate', { method: 'POST' }).then(function (uu) {
          checkBtn.disabled = false; upMsg.textContent = '';
          setUStat(uu && uu.behind, uu && uu.branch);
          upBtn.textContent = (uu && uu.behind) ? Tf('Upgrade now ({n})', { n: uu.behind }) : T('Upgrade');
        }).catch(function () { checkBtn.disabled = false; upMsg.textContent = T('Check failed.'); });
      });
      upBtn.addEventListener('click', function () {
        if (!confirm(T('Upgrade Zamolxis now? It will pull the latest, rebuild, and restart (about a minute).'))) return;
        upBtn.disabled = true; checkBtn.disabled = true; upMsg.textContent = T('Upgrading — pulling, building, restarting...');
        var before = (s.build && s.build.started) || 0;
        api('/api/update', { method: 'POST' }).then(function () {
          var tries = 0;
          (function poll() {
            tries++;
            api('/api/status').then(function (ns) {
              if (ns && ns.build && ns.build.started && ns.build.started !== before) { upMsg.textContent = T('Updated — reloading...'); setTimeout(function () { location.reload(); }, 800); }
              else if (tries < 60) { setTimeout(poll, 3000); }
              else { upMsg.textContent = T('Still working... reload manually in a bit.'); }
            }).catch(function () { if (tries < 60) setTimeout(poll, 3000); });
          })();
        }).catch(function () { upBtn.disabled = false; checkBtn.disabled = false; upMsg.textContent = T('Upgrade failed to start.'); });
      });

      // --- Maintenance ---
      pane.appendChild(el('label', null, T('Maintenance')));
      var rb = el('button', 'btn ghost', T('Restart Zamolxis'));
      var cl = el('a', 'btn ghost', T('Open classic UI')); cl.href = '/classic'; cl.target = '_blank'; cl.style.cssText = 'text-decoration:none;line-height:30px';
      var st = el('span', 'hint');
      var sr = el('div', 'save-row'); sr.appendChild(rb); sr.appendChild(cl); sr.appendChild(st); pane.appendChild(sr);
      rb.addEventListener('click', function () { restartZam(rb, st); });

      // --- Startup ---
      pane.appendChild(el('label', null, T('Autostart')));
      var asRow = el('div'); asRow.style.cssText = 'display:flex;align-items:center;gap:8px';
      var asTog = el('button', 'switch', "<span class='knob'></span>");
      var asNote = el('span', 'hint');
      asRow.appendChild(asTog); asRow.appendChild(el('span', 'hint', T('Run Zamolxis at login'))); asRow.appendChild(asNote);
      pane.appendChild(asRow);
      api('/api/autostart').then(function (st2) { if (!st2) return; if (st2.enabled) asTog.classList.add('on'); if (!st2.supported) asTog.style.opacity = '.5'; asNote.textContent = st2.note || ''; }).catch(function () {});
      asTog.addEventListener('click', function () { var want = !asTog.classList.contains('on'); asNote.textContent = '...'; api('/api/autostart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: want }) }).then(function (r) { asTog.classList.toggle('on', !!(r && r.enabled)); asNote.textContent = (r && r.note) || ''; }).catch(function () { asNote.textContent = T('Failed.'); }); });

      // --- Export setup (skills bundle; never includes secrets) ---
      pane.appendChild(el('label', null, T('Export setup')));
      var exBtn = el('button', 'btn ghost', T('Export setup')); var exNote = el('span', 'hint');
      var exRow = el('div', 'save-row'); exRow.appendChild(exBtn); exRow.appendChild(exNote); pane.appendChild(exRow);
      exBtn.addEventListener('click', function () {
        exBtn.disabled = true; exNote.textContent = '...'; var fn = 'zamolxis-setup.zip';
        fetch('/api/pack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) }).then(function (r) { if (!r.ok) throw 0; var cd = r.headers.get('content-disposition') || ''; var m = /filename="?([^";]+)"?/.exec(cd); if (m) fn = m[1]; return r.blob(); }).then(function (b) { var u = URL.createObjectURL(b); var a = document.createElement('a'); a.href = u; a.download = fn; a.click(); URL.revokeObjectURL(u); exBtn.disabled = false; exNote.textContent = T('Saved.'); }).catch(function () { exBtn.disabled = false; exNote.textContent = T('Failed.'); });
      });
    }).catch(function () { pane.innerHTML = ''; pane.appendChild(el('div', 'empty', T('Could not load status.'))); });
  }

  // ---------- App: New Agent ----------
  function mountNewAgent(body, win) {
    var pad = el('div', 'app-pad');
    function field(labelTxt, node, hint) { var f = el('div', 'field'); f.appendChild(el('label', null, labelTxt)); if (hint) f.appendChild(el('div', 'hint', hint)); f.appendChild(node); return f; }
    var name = el('input'); name.placeholder = T('e.g. researcher');
    var job = el('textarea'); job.rows = 4; job.placeholder = T('What should this agent do?');
    var model = el('select');
    name.style.cssText = 'width:100%;height:36px;border:1px solid #d6d6d6;border-radius:8px;padding:0 10px;font:inherit';
    model.style.cssText = 'width:100%;height:36px;border:1px solid #d6d6d6;border-radius:8px;padding:0 10px;font:inherit';
    job.style.cssText = 'width:100%;border:1px solid #d6d6d6;border-radius:8px;padding:8px 10px;font:inherit;resize:vertical';
    fillSelect(model, [['auto', 'Auto']], 'auto');
    fetchModelOpts().then(function (opts) { fillSelect(model, opts, 'auto'); });
    pad.appendChild(field(T('Agent name'), name));
    pad.appendChild(field(T('Instructions'), job, T('This becomes the agent app. It can run with or without a chat window.')));
    pad.appendChild(field(T('Model'), model, T('Auto, Local, Free cloud, any authenticated provider, or Claude.')));
    var msg = el('div', 'hint'); msg.style.minHeight = '16px';
    var create = el('button', 'btn', T('Create app'));
    create.addEventListener('click', function () {
      var n = name.value.trim(); if (!n) { msg.textContent = T('Name is required.'); return; }
      create.disabled = true; msg.textContent = T('Creating...');
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name: n, job: job.value.trim(), model: (model.value && model.value !== 'auto') ? model.value : undefined }) })
        .then(function (d) {
          create.disabled = false;
          if (d && d.error) { msg.textContent = String(d.error); return; }
          msg.textContent = T('Created. Added to the desktop.');
          if (d && d.agents) agents = d.agents; else loadAgents();
          renderDesktop();
        })
        .catch(function () { create.disabled = false; msg.textContent = T('Backend unreachable.'); });
    });
    var row = el('div'); row.style.cssText = 'display:flex;gap:10px;align-items:center'; row.appendChild(create); row.appendChild(msg);
    pad.appendChild(row);
    body.appendChild(pad);
  }

  // ---------- App: Help (extensive guide, localized) ----------
  var HELP = {
    en: `<h2>Zamolxis — Help &amp; Guide</h2>
<p>Zamolxis is your always-on personal assistant with a desktop you can use like a real operating system. This guide explains every part of the interface.</p>
<h3>The desktop</h3>
<ul>
<li><b>Windows</b> — every app opens in a window you can drag by its title bar, resize from any edge, minimize, maximize, or close.</li>
<li><b>Taskbar</b> — shows running apps; click one to focus it, or click it again to minimize. Zamolxis is always pinned.</li>
<li><b>Start menu</b> — click Start to see all apps and search them by name.</li>
<li><b>Desktop icons</b> — double-click to open an app. Drag icons anywhere; their position is remembered.</li>
</ul>
<h3>Apps are agents</h3>
<p>In Zamolxis every app is an agent (an AI worker). <b>Zamolxis</b> is the default app and hosts your main chat. Use <b>New Agent</b> to create your own: give it a name, instructions (what it should do) and a model. Each agent has a <b>Chat window</b> switch — turn it off to run headless (on demand or on a schedule) with just an activity feed, or on to chat with it directly.</p>
<h3>Chatting</h3>
<ul>
<li>Type your message and press Enter to send (Shift+Enter for a new line).</li>
<li>The <b>Route</b> selector picks which model answers: Auto, a local model, the free-cloud rotation, any provider you set up, or Claude.</li>
<li>The <b>attach</b> button adds files to your message (see Files below).</li>
<li>Conversations are saved on this device and restored when you reopen the app.</li>
</ul>
<h3>Models &amp; routing</h3>
<p>Zamolxis answers with a <b>free</b> model whenever one can do the job, and escalates to your Claude subscription only when needed — saving your Claude usage. In <b>Settings → Engine</b> you set three roles: <b>Model</b> (answers your chats), <b>Fast</b> (simple turns) and <b>Smartest</b> (hard turns / final fallback). Each can be a Claude variant, a local model, or any authenticated free provider.</p>
<h3>Providers &amp; free keys</h3>
<p>In <b>Settings → Providers</b> you can paste an API key for each provider (many have generous free tiers — Google Gemini, Cerebras, Groq and more). A key takes effect after a restart (System tab). Saving an empty key, or pressing <b>Remove</b>, deletes that provider's key.</p>
<h3>Files</h3>
<ul>
<li><b>Text &amp; code</b> — read inline by any model.</li>
<li><b>PDF, Word, Excel, PowerPoint</b> — their text is extracted on the server so any model can read it.</li>
<li><b>Images</b> — sent to a free vision model (Gemini) to be described or analyzed.</li>
</ul>
<p>The same free-first rule applies: only files that truly need Claude are routed to it.</p>
<h3>Skills</h3>
<p><b>Settings → Skills</b> lists the abilities Zamolxis can use. Toggle one on or off, or <b>Import</b> an external skill to make it your own.</p>
<h3>Appearance &amp; language</h3>
<p><b>Settings → Appearance</b> lets you match Windows, macOS or Ubuntu (or Auto-detect), switch Light/Dark (or follow the system), and choose the interface <b>Language</b>. English is the default; anything not yet translated stays in English.</p>
<h3>Keeping up to date</h3>
<p><b>Settings → System</b> shows your version and a one-click <b>Upgrade</b> that pulls the latest, rebuilds and restarts — no manual commands. You can also restart Zamolxis or open the classic interface here.</p>
<h3>Tips</h3>
<ul>
<li>Click the clock to open Settings quickly.</li>
<li>Double-click a window's title bar to maximize it.</li>
<li>Your open windows and their positions are restored next time you load the desktop.</li>
</ul>`,
    es: `<h2>Zamolxis — Ayuda y guía</h2>
<p>Zamolxis es tu asistente personal siempre activo, con un escritorio que puedes usar como un sistema operativo real. Esta guía explica cada parte de la interfaz.</p>
<h3>El escritorio</h3>
<ul>
<li><b>Ventanas</b> — cada app se abre en una ventana que puedes arrastrar por su barra de título, redimensionar desde cualquier borde, minimizar, maximizar o cerrar.</li>
<li><b>Barra de tareas</b> — muestra las apps en ejecución; haz clic para enfocar una o clic de nuevo para minimizarla. Zamolxis siempre está fijado.</li>
<li><b>Menú de inicio</b> — haz clic en Inicio para ver todas las apps y buscarlas por nombre.</li>
<li><b>Iconos del escritorio</b> — doble clic para abrir una app. Arrastra los iconos a donde quieras; se recuerda su posición.</li>
</ul>
<h3>Las apps son agentes</h3>
<p>En Zamolxis cada app es un agente (un trabajador de IA). <b>Zamolxis</b> es la app predeterminada y aloja tu chat principal. Usa <b>Nuevo agente</b> para crear el tuyo: dale un nombre, instrucciones (qué debe hacer) y un modelo. Cada agente tiene un interruptor de <b>Ventana de chat</b> — desactívalo para ejecutarlo sin interfaz (bajo demanda o según horario) con solo un registro de actividad, o actívalo para hablar con él directamente.</p>
<h3>Conversar</h3>
<ul>
<li>Escribe tu mensaje y pulsa Enter para enviar (Mayús+Enter para una nueva línea).</li>
<li>El selector de <b>Ruta</b> elige qué modelo responde: Auto, un modelo local, la rotación de nube gratuita, cualquier proveedor que hayas configurado o Claude.</li>
<li>El botón de <b>adjuntar</b> añade archivos a tu mensaje (ver Archivos más abajo).</li>
<li>Las conversaciones se guardan en este dispositivo y se restauran al reabrir la app.</li>
</ul>
<h3>Modelos y enrutamiento</h3>
<p>Zamolxis responde con un modelo <b>gratuito</b> siempre que alguno pueda hacer el trabajo, y solo recurre a tu suscripción de Claude cuando hace falta, ahorrando tu uso de Claude. En <b>Ajustes → Motor</b> defines tres roles: <b>Modelo</b> (responde tus chats), <b>Rápido</b> (turnos simples) y <b>Más inteligente</b> (turnos difíciles / respaldo final). Cada uno puede ser una variante de Claude, un modelo local o cualquier proveedor gratuito autenticado.</p>
<h3>Proveedores y claves gratuitas</h3>
<p>En <b>Ajustes → Proveedores</b> puedes pegar una clave API para cada proveedor (muchos tienen generosos planes gratuitos: Google Gemini, Cerebras, Groq y más). Una clave surte efecto tras reiniciar (pestaña Sistema). Guardar una clave vacía, o pulsar <b>Quitar</b>, elimina la clave de ese proveedor.</p>
<h3>Archivos</h3>
<ul>
<li><b>Texto y código</b> — los lee directamente cualquier modelo.</li>
<li><b>PDF, Word, Excel, PowerPoint</b> — su texto se extrae en el servidor para que cualquier modelo pueda leerlo.</li>
<li><b>Imágenes</b> — se envían a un modelo de visión gratuito (Gemini) para describirlas o analizarlas.</li>
</ul>
<p>Se aplica la misma regla de gratis primero: solo los archivos que realmente necesitan a Claude se le envían.</p>
<h3>Habilidades</h3>
<p><b>Ajustes → Habilidades</b> enumera las capacidades que Zamolxis puede usar. Activa o desactiva una, o <b>Importa</b> una habilidad externa para hacerla tuya.</p>
<h3>Apariencia e idioma</h3>
<p><b>Ajustes → Apariencia</b> te permite imitar Windows, macOS o Ubuntu (o detectarlo automáticamente), alternar entre claro y oscuro (o seguir al sistema) y elegir el <b>Idioma</b> de la interfaz. El inglés es el predeterminado; lo que aún no esté traducido permanece en inglés.</p>
<h3>Mantenerse al día</h3>
<p><b>Ajustes → Sistema</b> muestra tu versión y un botón <b>Actualizar</b> de un clic que descarga lo último, recompila y reinicia, sin comandos manuales. Aquí también puedes reiniciar Zamolxis o abrir la interfaz clásica.</p>
<h3>Consejos</h3>
<ul>
<li>Haz clic en el reloj para abrir Ajustes rápidamente.</li>
<li>Doble clic en la barra de título de una ventana para maximizarla.</li>
<li>Tus ventanas abiertas y sus posiciones se restauran la próxima vez que cargues el escritorio.</li>
</ul>`,
    fr: `<h2>Zamolxis — Aide et guide</h2>
<p>Zamolxis est votre assistant personnel toujours actif, doté d'un bureau que vous utilisez comme un véritable système d'exploitation. Ce guide explique chaque partie de l'interface.</p>
<h3>Le bureau</h3>
<ul>
<li><b>Fenêtres</b> — chaque app s'ouvre dans une fenêtre que vous pouvez déplacer par sa barre de titre, redimensionner depuis n'importe quel bord, réduire, agrandir ou fermer.</li>
<li><b>Barre des tâches</b> — affiche les apps en cours ; cliquez pour en activer une, ou recliquez pour la réduire. Zamolxis est toujours épinglé.</li>
<li><b>Menu Démarrer</b> — cliquez sur Démarrer pour voir toutes les apps et les rechercher par nom.</li>
<li><b>Icônes du bureau</b> — double-cliquez pour ouvrir une app. Déplacez les icônes où vous voulez ; leur position est mémorisée.</li>
</ul>
<h3>Les apps sont des agents</h3>
<p>Dans Zamolxis, chaque app est un agent (un travailleur IA). <b>Zamolxis</b> est l'app par défaut et héberge votre discussion principale. Utilisez <b>Nouvel agent</b> pour créer le vôtre : donnez-lui un nom, des instructions (ce qu'il doit faire) et un modèle. Chaque agent possède un interrupteur <b>Fenêtre de discussion</b> — désactivez-le pour un fonctionnement sans interface (à la demande ou planifié) avec un simple flux d'activité, ou activez-le pour lui parler directement.</p>
<h3>Discuter</h3>
<ul>
<li>Saisissez votre message et appuyez sur Entrée pour l'envoyer (Maj+Entrée pour une nouvelle ligne).</li>
<li>Le sélecteur <b>Routage</b> choisit le modèle qui répond : Auto, un modèle local, la rotation du cloud gratuit, tout fournisseur configuré, ou Claude.</li>
<li>Le bouton <b>joindre</b> ajoute des fichiers à votre message (voir Fichiers ci-dessous).</li>
<li>Les conversations sont enregistrées sur cet appareil et restaurées à la réouverture de l'app.</li>
</ul>
<h3>Modèles et routage</h3>
<p>Zamolxis répond avec un modèle <b>gratuit</b> dès que l'un d'eux peut faire le travail, et ne recourt à votre abonnement Claude que si nécessaire, économisant votre usage de Claude. Dans <b>Paramètres → Moteur</b>, vous définissez trois rôles : <b>Modèle</b> (répond à vos discussions), <b>Rapide</b> (tours simples) et <b>Plus intelligent</b> (tours difficiles / dernier recours). Chacun peut être une variante de Claude, un modèle local ou tout fournisseur gratuit authentifié.</p>
<h3>Fournisseurs et clés gratuites</h3>
<p>Dans <b>Paramètres → Fournisseurs</b>, vous pouvez coller une clé API pour chaque fournisseur (beaucoup offrent des paliers gratuits généreux : Google Gemini, Cerebras, Groq et d'autres). Une clé prend effet après un redémarrage (onglet Système). Enregistrer une clé vide, ou appuyer sur <b>Retirer</b>, supprime la clé de ce fournisseur.</p>
<h3>Fichiers</h3>
<ul>
<li><b>Texte et code</b> — lus directement par n'importe quel modèle.</li>
<li><b>PDF, Word, Excel, PowerPoint</b> — leur texte est extrait sur le serveur pour que tout modèle puisse le lire.</li>
<li><b>Images</b> — envoyées à un modèle de vision gratuit (Gemini) pour être décrites ou analysées.</li>
</ul>
<p>La même règle « gratuit d'abord » s'applique : seuls les fichiers qui nécessitent vraiment Claude lui sont envoyés.</p>
<h3>Compétences</h3>
<p><b>Paramètres → Compétences</b> répertorie les capacités que Zamolxis peut utiliser. Activez ou désactivez l'une d'elles, ou <b>Importez</b> une compétence externe pour qu'elle devienne la vôtre.</p>
<h3>Apparence et langue</h3>
<p><b>Paramètres → Apparence</b> vous permet d'imiter Windows, macOS ou Ubuntu (ou la détection automatique), de basculer entre clair et sombre (ou de suivre le système) et de choisir la <b>Langue</b> de l'interface. L'anglais est la langue par défaut ; ce qui n'est pas encore traduit reste en anglais.</p>
<h3>Rester à jour</h3>
<p><b>Paramètres → Système</b> affiche votre version et un bouton <b>Mettre à jour</b> en un clic qui récupère la dernière version, recompile et redémarre, sans commandes manuelles. Vous pouvez aussi y redémarrer Zamolxis ou ouvrir l'interface classique.</p>
<h3>Astuces</h3>
<ul>
<li>Cliquez sur l'horloge pour ouvrir rapidement les Paramètres.</li>
<li>Double-cliquez sur la barre de titre d'une fenêtre pour l'agrandir.</li>
<li>Vos fenêtres ouvertes et leurs positions sont restaurées au prochain chargement du bureau.</li>
</ul>`,
    de: `<h2>Zamolxis — Hilfe und Anleitung</h2>
<p>Zamolxis ist Ihr stets verfügbarer persönlicher Assistent mit einem Desktop, den Sie wie ein echtes Betriebssystem nutzen. Diese Anleitung erklärt jeden Teil der Oberfläche.</p>
<h3>Der Desktop</h3>
<ul>
<li><b>Fenster</b> — jede App öffnet sich in einem Fenster, das Sie an der Titelleiste verschieben, an jeder Kante in der Größe ändern, minimieren, maximieren oder schließen können.</li>
<li><b>Taskleiste</b> — zeigt laufende Apps; klicken Sie zum Fokussieren oder erneut zum Minimieren. Zamolxis ist immer angeheftet.</li>
<li><b>Startmenü</b> — klicken Sie auf Start, um alle Apps zu sehen und nach Namen zu suchen.</li>
<li><b>Desktop-Symbole</b> — doppelklicken zum Öffnen einer App. Ziehen Sie Symbole beliebig; ihre Position wird gemerkt.</li>
</ul>
<h3>Apps sind Agenten</h3>
<p>In Zamolxis ist jede App ein Agent (ein KI-Arbeiter). <b>Zamolxis</b> ist die Standard-App und beherbergt Ihren Haupt-Chat. Mit <b>Neuer Agent</b> erstellen Sie eigene: geben Sie Name, Anweisungen (was er tun soll) und ein Modell an. Jeder Agent hat einen Schalter <b>Chatfenster</b> — schalten Sie ihn aus, um ohne Oberfläche zu laufen (auf Abruf oder nach Zeitplan) mit nur einem Aktivitäts-Feed, oder ein, um direkt mit ihm zu chatten.</p>
<h3>Chatten</h3>
<ul>
<li>Tippen Sie Ihre Nachricht und drücken Sie Enter zum Senden (Umschalt+Enter für eine neue Zeile).</li>
<li>Der <b>Route</b>-Wähler bestimmt, welches Modell antwortet: Auto, ein lokales Modell, die kostenlose Cloud-Rotation, ein eingerichteter Anbieter oder Claude.</li>
<li>Die Schaltfläche <b>Anhängen</b> fügt Dateien zu Ihrer Nachricht hinzu (siehe Dateien unten).</li>
<li>Unterhaltungen werden auf diesem Gerät gespeichert und beim erneuten Öffnen der App wiederhergestellt.</li>
</ul>
<h3>Modelle und Routing</h3>
<p>Zamolxis antwortet mit einem <b>kostenlosen</b> Modell, sobald eines die Aufgabe erledigen kann, und greift nur bei Bedarf auf Ihr Claude-Abonnement zurück — das spart Ihre Claude-Nutzung. Unter <b>Einstellungen → Engine</b> legen Sie drei Rollen fest: <b>Modell</b> (beantwortet Ihre Chats), <b>Schnell</b> (einfache Schritte) und <b>Klügstes</b> (schwierige Schritte / letzte Rückfallebene). Jede kann eine Claude-Variante, ein lokales Modell oder ein beliebiger authentifizierter kostenloser Anbieter sein.</p>
<h3>Anbieter und kostenlose Schlüssel</h3>
<p>Unter <b>Einstellungen → Anbieter</b> können Sie für jeden Anbieter einen API-Schlüssel einfügen (viele haben großzügige kostenlose Kontingente — Google Gemini, Cerebras, Groq und mehr). Ein Schlüssel wird nach einem Neustart wirksam (Tab System). Ein leerer Schlüssel beim Speichern oder <b>Entfernen</b> löscht den Schlüssel dieses Anbieters.</p>
<h3>Dateien</h3>
<ul>
<li><b>Text und Code</b> — direkt von jedem Modell gelesen.</li>
<li><b>PDF, Word, Excel, PowerPoint</b> — ihr Text wird auf dem Server extrahiert, damit jedes Modell ihn lesen kann.</li>
<li><b>Bilder</b> — an ein kostenloses Vision-Modell (Gemini) gesendet, um beschrieben oder analysiert zu werden.</li>
</ul>
<p>Es gilt dieselbe Regel „kostenlos zuerst“: nur Dateien, die wirklich Claude brauchen, gehen an ihn.</p>
<h3>Fähigkeiten</h3>
<p><b>Einstellungen → Fähigkeiten</b> listet die Fähigkeiten auf, die Zamolxis nutzen kann. Schalten Sie eine ein oder aus, oder <b>Importieren</b> Sie eine externe Fähigkeit, um sie zu Ihrer eigenen zu machen.</p>
<h3>Darstellung und Sprache</h3>
<p><b>Einstellungen → Darstellung</b> lässt Sie Windows, macOS oder Ubuntu nachahmen (oder automatisch erkennen), zwischen Hell und Dunkel wechseln (oder dem System folgen) und die <b>Sprache</b> der Oberfläche wählen. Englisch ist Standard; noch nicht Übersetztes bleibt auf Englisch.</p>
<h3>Aktuell bleiben</h3>
<p><b>Einstellungen → System</b> zeigt Ihre Version und eine <b>Aktualisieren</b>-Schaltfläche mit einem Klick, die die neueste Version lädt, neu baut und neu startet — ohne manuelle Befehle. Hier können Sie auch Zamolxis neu starten oder die klassische Oberfläche öffnen.</p>
<h3>Tipps</h3>
<ul>
<li>Klicken Sie auf die Uhr, um die Einstellungen schnell zu öffnen.</li>
<li>Doppelklicken Sie auf die Titelleiste eines Fensters, um es zu maximieren.</li>
<li>Ihre geöffneten Fenster und deren Positionen werden beim nächsten Laden des Desktops wiederhergestellt.</li>
</ul>`,
    ro: `<h2>Zamolxis — Ajutor și ghid</h2>
<p>Zamolxis este asistentul tău personal mereu activ, cu un desktop pe care îl folosești ca un sistem de operare adevărat. Acest ghid explică fiecare parte a interfeței.</p>
<h3>Desktopul</h3>
<ul>
<li><b>Ferestre</b> — fiecare aplicație se deschide într-o fereastră pe care o poți muta de bara de titlu, redimensiona din orice margine, minimiza, maximiza sau închide.</li>
<li><b>Bara de activități</b> — arată aplicațiile pornite; dă clic pentru a focaliza una sau clic din nou pentru a o minimiza. Zamolxis este mereu fixat.</li>
<li><b>Meniul Start</b> — dă clic pe Start pentru a vedea toate aplicațiile și a le căuta după nume.</li>
<li><b>Pictograme pe desktop</b> — dublu clic pentru a deschide o aplicație. Trage pictogramele oriunde; poziția lor este reținută.</li>
</ul>
<h3>Aplicațiile sunt agenți</h3>
<p>În Zamolxis fiecare aplicație este un agent (un lucrător IA). <b>Zamolxis</b> este aplicația implicită și găzduiește conversația principală. Folosește <b>Agent nou</b> pentru a-l crea pe al tău: dă-i un nume, instrucțiuni (ce trebuie să facă) și un model. Fiecare agent are un comutator <b>Fereastră de chat</b> — oprește-l pentru a rula fără interfață (la cerere sau programat) doar cu un flux de activitate, sau pornește-l pentru a vorbi direct cu el.</p>
<h3>Conversația</h3>
<ul>
<li>Scrie mesajul și apasă Enter pentru a-l trimite (Shift+Enter pentru rând nou).</li>
<li>Selectorul <b>Rutare</b> alege ce model răspunde: Auto, un model local, rotația de cloud gratuit, orice furnizor configurat sau Claude.</li>
<li>Butonul de <b>atașare</b> adaugă fișiere la mesajul tău (vezi Fișiere mai jos).</li>
<li>Conversațiile se salvează pe acest dispozitiv și se restaurează la redeschiderea aplicației.</li>
</ul>
<h3>Modele și rutare</h3>
<p>Zamolxis răspunde cu un model <b>gratuit</b> ori de câte ori unul poate face treaba și recurge la abonamentul Claude doar când e nevoie, economisind utilizarea Claude. În <b>Setări → Motor</b> stabilești trei roluri: <b>Model</b> (răspunde la conversații), <b>Rapid</b> (ture simple) și <b>Cel mai inteligent</b> (ture dificile / rezervă finală). Fiecare poate fi o variantă Claude, un model local sau orice furnizor gratuit autentificat.</p>
<h3>Furnizori și chei gratuite</h3>
<p>În <b>Setări → Furnizori</b> poți lipi o cheie API pentru fiecare furnizor (mulți au niveluri gratuite generoase — Google Gemini, Cerebras, Groq și altele). O cheie intră în vigoare după repornire (fila Sistem). Salvarea unei chei goale sau apăsarea pe <b>Elimină</b> șterge cheia acelui furnizor.</p>
<h3>Fișiere</h3>
<ul>
<li><b>Text și cod</b> — citite direct de orice model.</li>
<li><b>PDF, Word, Excel, PowerPoint</b> — textul lor este extras pe server ca orice model să îl poată citi.</li>
<li><b>Imagini</b> — trimise unui model de vedere gratuit (Gemini) pentru a fi descrise sau analizate.</li>
</ul>
<p>Se aplică aceeași regulă „întâi gratuit”: doar fișierele care chiar au nevoie de Claude îi sunt trimise.</p>
<h3>Abilități</h3>
<p><b>Setări → Abilități</b> listează capacitățile pe care Zamolxis le poate folosi. Activează sau dezactivează una, sau <b>Importă</b> o abilitate externă ca să devină a ta.</p>
<h3>Aspect și limbă</h3>
<p><b>Setări → Aspect</b> îți permite să imiți Windows, macOS sau Ubuntu (sau detectare automată), să comuți între luminos și întunecat (sau să urmezi sistemul) și să alegi <b>Limba</b> interfeței. Engleza este implicită; ce nu este încă tradus rămâne în engleză.</p>
<h3>Menținerea la zi</h3>
<p><b>Setări → Sistem</b> arată versiunea ta și un buton <b>Actualizează</b> dintr-un clic care descarcă ultima versiune, recompilează și repornește, fără comenzi manuale. Tot aici poți reporni Zamolxis sau deschide interfața clasică.</p>
<h3>Sfaturi</h3>
<ul>
<li>Dă clic pe ceas pentru a deschide rapid Setările.</li>
<li>Dublu clic pe bara de titlu a unei ferestre pentru a o maximiza.</li>
<li>Ferestrele deschise și pozițiile lor se restaurează la următoarea încărcare a desktopului.</li>
</ul>`,
    it: `<h2>Zamolxis — Aiuto e guida</h2>
<p>Zamolxis è il tuo assistente personale sempre attivo, con un desktop che puoi usare come un vero sistema operativo. Questa guida spiega ogni parte dell'interfaccia.</p>
<h3>Il desktop</h3>
<ul>
<li><b>Finestre</b> — ogni app si apre in una finestra che puoi spostare dalla barra del titolo, ridimensionare da qualsiasi bordo, ridurre a icona, ingrandire o chiudere.</li>
<li><b>Barra delle applicazioni</b> — mostra le app in esecuzione; fai clic per attivarne una o di nuovo per ridurla a icona. Zamolxis è sempre fissato.</li>
<li><b>Menu Start</b> — fai clic su Start per vedere tutte le app e cercarle per nome.</li>
<li><b>Icone del desktop</b> — doppio clic per aprire un'app. Trascina le icone dove vuoi; la loro posizione viene ricordata.</li>
</ul>
<h3>Le app sono agenti</h3>
<p>In Zamolxis ogni app è un agente (un lavoratore IA). <b>Zamolxis</b> è l'app predefinita e ospita la chat principale. Usa <b>Nuovo agente</b> per crearne uno tuo: dagli un nome, istruzioni (cosa deve fare) e un modello. Ogni agente ha un interruttore <b>Finestra di chat</b> — spegnilo per eseguirlo senza interfaccia (su richiesta o pianificato) con solo un flusso di attività, oppure accendilo per parlarci direttamente.</p>
<h3>Chattare</h3>
<ul>
<li>Scrivi il messaggio e premi Invio per inviarlo (Maiusc+Invio per andare a capo).</li>
<li>Il selettore <b>Instradamento</b> sceglie quale modello risponde: Auto, un modello locale, la rotazione del cloud gratuito, qualsiasi provider configurato o Claude.</li>
<li>Il pulsante <b>allega</b> aggiunge file al tuo messaggio (vedi File qui sotto).</li>
<li>Le conversazioni vengono salvate su questo dispositivo e ripristinate alla riapertura dell'app.</li>
</ul>
<h3>Modelli e instradamento</h3>
<p>Zamolxis risponde con un modello <b>gratuito</b> ogni volta che uno può svolgere il compito e passa al tuo abbonamento Claude solo quando serve, risparmiando l'uso di Claude. In <b>Impostazioni → Motore</b> imposti tre ruoli: <b>Modello</b> (risponde alle chat), <b>Veloce</b> (turni semplici) e <b>Più intelligente</b> (turni difficili / ripiego finale). Ognuno può essere una variante di Claude, un modello locale o qualsiasi provider gratuito autenticato.</p>
<h3>Provider e chiavi gratuite</h3>
<p>In <b>Impostazioni → Provider</b> puoi incollare una chiave API per ogni provider (molti hanno generosi piani gratuiti — Google Gemini, Cerebras, Groq e altri). Una chiave ha effetto dopo un riavvio (scheda Sistema). Salvare una chiave vuota, o premere <b>Rimuovi</b>, elimina la chiave di quel provider.</p>
<h3>File</h3>
<ul>
<li><b>Testo e codice</b> — letti direttamente da qualsiasi modello.</li>
<li><b>PDF, Word, Excel, PowerPoint</b> — il loro testo viene estratto sul server così qualsiasi modello può leggerlo.</li>
<li><b>Immagini</b> — inviate a un modello di visione gratuito (Gemini) per essere descritte o analizzate.</li>
</ul>
<p>Vale la stessa regola del gratuito prima: solo i file che hanno davvero bisogno di Claude vengono inviati a lui.</p>
<h3>Competenze</h3>
<p><b>Impostazioni → Competenze</b> elenca le capacità che Zamolxis può usare. Attiva o disattiva una, oppure <b>Importa</b> una competenza esterna per renderla tua.</p>
<h3>Aspetto e lingua</h3>
<p><b>Impostazioni → Aspetto</b> ti permette di imitare Windows, macOS o Ubuntu (o il rilevamento automatico), passare tra chiaro e scuro (o seguire il sistema) e scegliere la <b>Lingua</b> dell'interfaccia. L'inglese è predefinito; ciò che non è ancora tradotto resta in inglese.</p>
<h3>Restare aggiornati</h3>
<p><b>Impostazioni → Sistema</b> mostra la tua versione e un pulsante <b>Aggiorna</b> con un clic che scarica l'ultima versione, ricompila e riavvia, senza comandi manuali. Qui puoi anche riavviare Zamolxis o aprire l'interfaccia classica.</p>
<h3>Suggerimenti</h3>
<ul>
<li>Fai clic sull'orologio per aprire rapidamente le Impostazioni.</li>
<li>Doppio clic sulla barra del titolo di una finestra per ingrandirla.</li>
<li>Le finestre aperte e le loro posizioni vengono ripristinate al successivo caricamento del desktop.</li>
</ul>`
  };
  function mountHelp(body, win) {
    body.style.padding = '0';
    var wrap = el('div', 'help-doc');
    wrap.style.cssText = 'height:100%;overflow:auto;padding:18px 24px';
    wrap.innerHTML = (HELP[langChoice()] || HELP.en);
    body.appendChild(wrap);
  }

  // ============================================================
  // Native file apps: File Manager, Text Editor, Calculator, viewers
  // ============================================================
  function fsapi(op, extra) { return api('/api/fs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ op: op }, extra || {})) }); }
  function fileUrl(rel, download) { return '/api/file?path=' + encodeURIComponent(rel) + (download ? '&download=1' : ''); }
  var TEXT_OPEN = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|xml|html?|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|swift|sh|bash|zsh|ps1|bat|sql|ini|toml|cfg|conf|log|env|tex|rst|gradle|properties)$/i;
  var IMG_OPEN = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
  var AV_OPEN = /\.(mp4|webm|mkv|mov|m4v|ogg|ogv|mp3|wav|m4a|flac|aac|opus)$/i;
  var DOC_OPEN = /\.(docx?|odt)$/i;
  var SHEET_OPEN = /\.(xlsx?|ods)$/i;
  function humanSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'; return (n / 1073741824).toFixed(2) + ' GB'; }
  function iconForName(name) { if (IMG_OPEN.test(name)) return ICON.image; if (AV_OPEN.test(name)) return ICON.film; if (/\.pdf$/i.test(name)) return ICON.pdf; if (/\.epub$/i.test(name)) return ICON.book; if (DOC_OPEN.test(name)) return ICON.doc; if (SHEET_OPEN.test(name)) return ICON.sheet; return ICON.editor; }
  function bytesToB64(bytes) { var bin = ''; var chunk = 0x8000; for (var i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)); return btoa(bin); }
  function loadScript(src, cb) {
    var ex = document.querySelector('script[data-src="' + src + '"]');
    if (ex) { if (ex.getAttribute('data-loaded') === '1') return cb(true); ex.addEventListener('load', function () { cb(true); }); ex.addEventListener('error', function () { cb(false); }); return; }
    var s = document.createElement('script'); s.src = src; s.setAttribute('data-src', src);
    s.onload = function () { s.setAttribute('data-loaded', '1'); cb(true); }; s.onerror = function () { cb(false); };
    document.head.appendChild(s);
  }
  // Open an instance window NOT tied to the singleton registry (so multiple files can be open).
  function spawnApp(idBase, title, iconSvg, w, h, mountFn) {
    var inst = makeWindow({ appId: idBase, title: title, iconSvg: iconSvg, w: w, h: h, onMount: mountFn });
    inst._iconSvg = iconSvg; inst._appTitle = title; syncTaskbar(); return inst;
  }
  function baseName(p) { return (p || '').split(/[\\/]/).pop(); }
  // Mount the right viewer/editor for a file INTO the given window body.
  function mountForFile(body, win, abs) {
    var name = baseName(abs);
    if (TEXT_OPEN.test(name)) return mountTextEditor(body, win, abs);
    if (IMG_OPEN.test(name)) return mountImageViewer(body, win, abs);
    if (AV_OPEN.test(name)) return mountMediaPlayer(body, win, abs);
    if (/\.pdf$/i.test(name)) return mountPdf(body, win, abs);
    if (/\.epub$/i.test(name)) return mountEbook(body, win, abs);
    if (DOC_OPEN.test(name)) return mountDocViewer(body, win, abs, 'doc');
    if (SHEET_OPEN.test(name)) return mountDocViewer(body, win, abs, 'sheet');
    window.open(fileUrl(abs, true), '_blank');
    body.appendChild(el('div', 'hint', name));
  }
  // Open a file in a NEW window (used by File Manager double-click).
  function openFile(abs) {
    var name = baseName(abs);
    spawnApp('view:' + abs, name, iconForName(name), 820, 660, function (b, w) { mountForFile(b, w, abs); });
  }
  // Open a file by REUSING an existing window (used by the "Open…" file picker so we don't
  // pile up windows): clear the window, re-title it, and mount the right viewer in place.
  function openInWindow(win, abs) {
    win.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} }); win.cleanup = [];
    if (win.menubar) { win.menubar.innerHTML = ''; win.menubar.style.display = 'none'; }
    win._menuModel = null; win.body.innerHTML = ''; win.body.style.padding = '';
    win._appTitle = baseName(abs); win.titleEl.textContent = win._appTitle; win._iconSvg = iconForName(baseName(abs));
    mountForFile(win.body, win, abs);
    focusWin(win); syncTaskbar();
  }
  // A File-Manager window in "pick a file" mode: choosing a file calls cb(abs) then closes the picker.
  function pickFile(cb) {
    spawnApp('filepick:' + (++seq), T('Open') + '…', ICON.files, 720, 520, function (b, w) {
      mountFiles(b, w, { pick: function (abs) { try { cb(abs); } catch (e) {} closeWin(w); } });
    });
  }

  function mountFiles(body, win, opts) {
    opts = opts || {};
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column;font-size:13px';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid rgba(128,128,128,.2);flex-wrap:wrap';
    var upBtn = el('button', 'btn ghost', '↰'); upBtn.title = 'Up';
    var homeBtn = el('button', 'btn ghost', '⌂'); homeBtn.title = 'Home';
    var pathInp = el('input', 'inp'); pathInp.style.cssText = 'flex:1;min-width:120px';
    var refreshBtn = el('button', 'btn ghost', T('Refresh'));
    var mkdirBtn = el('button', 'btn ghost', T('New folder'));
    var newFileBtn = el('button', 'btn ghost', T('New file'));
    var upFileBtn = el('button', 'btn ghost', '📎'); upFileBtn.title = T('Attach files');
    var fileIn = el('input'); fileIn.type = 'file'; fileIn.multiple = true; fileIn.style.display = 'none';
    [upBtn, homeBtn, pathInp, refreshBtn, mkdirBtn, newFileBtn, upFileBtn].forEach(function (e) { bar.appendChild(e); });
    if (opts.pick) { var pb = el('div', 'hint'); pb.style.cssText = 'padding:4px 10px;background:rgba(0,103,192,.14)'; pb.textContent = T('Select a file to open'); wrap.appendChild(bar); wrap.appendChild(pb); } else { wrap.appendChild(bar); }
    var list = el('div'); list.style.cssText = 'flex:1;overflow:auto;padding:6px';
    var status = el('div', 'hint'); status.style.cssText = 'padding:4px 8px;border-top:1px solid rgba(128,128,128,.2)';
    wrap.appendChild(list); wrap.appendChild(status); body.appendChild(wrap); body.appendChild(fileIn);
    var cur = '', sep = '\\', homePath = '', parentPath = null;
    function join(dir, name) { if (!dir) return name; var last = dir.charAt(dir.length - 1); return (last === sep || last === '/') ? dir + name : dir + sep + name; }
    function load(p) {
      fsapi('list', { path: p }).then(function (d) {
        if (d.error) { status.textContent = d.error; return; }
        cur = d.path; sep = d.sep || sep; homePath = d.home || homePath; parentPath = (d.parent === undefined ? null : d.parent);
        try { localStorage.setItem('zx_fm_path', cur); } catch (e) {}
        pathInp.value = (cur === '::drives' || cur === '') ? 'This PC' : cur;
        upBtn.style.visibility = (parentPath == null) ? 'hidden' : '';
        list.innerHTML = '';
        if (!d.items.length) list.appendChild(el('div', 'hint', T('empty folder')));
        d.items.forEach(function (it) {
          var childAbs = it.abs;
          var row = el('div', 'fm-row');
          var ic = el('span', 'fm-ico', it.dir ? ICON.files : iconForName(it.name));
          var nm = el('span'); nm.textContent = it.name; nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          var meta = el('span', 'hint'); meta.textContent = it.dir ? '' : humanSize(it.size);
          var act = el('span', 'fm-act');
          if (!d.drives) {
            var rn = el('button', 'btn ghost mini', T('Rename'));
            rn.addEventListener('click', function (e) { e.stopPropagation(); var nn = prompt(T('Rename'), it.name); if (nn && nn !== it.name) fsapi('rename', { path: childAbs, to: join(cur, nn) }).then(function () { load(cur); }); });
            act.appendChild(rn);
            if (!it.dir) { var dl = el('a', 'btn ghost mini', T('Download')); dl.href = fileUrl(childAbs, true); dl.style.cssText = 'text-decoration:none'; act.appendChild(dl); }
            var del = el('button', 'btn ghost mini', T('Delete'));
            del.addEventListener('click', function (e) { e.stopPropagation(); if (confirm(T('Delete') + ' "' + it.name + '"?')) fsapi('delete', { path: childAbs }).then(function () { load(cur); }); });
            act.appendChild(del);
          }
          row.appendChild(ic); row.appendChild(nm); row.appendChild(meta); row.appendChild(act);
          row.addEventListener('dblclick', function () { if (it.dir) load(childAbs); else if (opts.pick) opts.pick(childAbs); else openFile(childAbs); });
          list.appendChild(row);
        });
        status.textContent = d.items.length + ' items' + (cur && cur !== '::drives' ? ' · ' + cur : '');
      }).catch(function () { status.textContent = 'error'; });
    }
    upBtn.addEventListener('click', function () { if (parentPath != null) load(parentPath); });
    homeBtn.addEventListener('click', function () { load(homePath || ''); });
    refreshBtn.addEventListener('click', function () { load(cur); });
    pathInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var v = pathInp.value.trim(); load(v === 'This PC' ? '::drives' : v); } });
    mkdirBtn.addEventListener('click', function () { var n = prompt(T('New folder')); if (n) fsapi('mkdir', { path: join(cur, n) }).then(function () { load(cur); }); });
    newFileBtn.addEventListener('click', function () { var n = prompt(T('New file')); if (n) { var np = join(cur, n); fsapi('write', { path: np, content: '' }).then(function () { load(cur); if (opts.pick) opts.pick(np); else openFile(np); }); } });
    upFileBtn.addEventListener('click', function () { fileIn.click(); });
    fileIn.addEventListener('change', function () {
      var arr = [].slice.call(fileIn.files || []); fileIn.value = '';
      var i = 0; function next() { if (i >= arr.length) { load(cur); return; } var f = arr[i++]; var rd = new FileReader(); rd.onload = function () { var s = String(rd.result || ''); var c = s.indexOf(','); var b64 = c >= 0 ? s.slice(c + 1) : s; fsapi('writeB64', { path: join(cur, f.name), content: b64 }).then(next).catch(next); }; rd.readAsDataURL(f); }
      next();
    });
    win.setMenus([
      { label: T('File'), items: [
        { label: T('New file'), action: function () { newFileBtn.click(); } },
        { label: T('New folder'), action: function () { mkdirBtn.click(); } },
        { label: T('Upload') + '...', action: function () { upFileBtn.click(); } }
      ] },
      { label: T('View'), items: [
        { label: T('Refresh'), accel: 'F5', action: function () { refreshBtn.click(); } },
        { label: 'Home', action: function () { homeBtn.click(); } },
        { label: 'Up', action: function () { upBtn.click(); } },
        { label: 'This PC', action: function () { load('::drives'); } }
      ] }
    ]);
    load(localStorage.getItem('zx_fm_path') || '');
  }

  function mountTextEditor(body, win, rel) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid rgba(128,128,128,.2)';
    var saveBtn = el('button', 'btn', T('Save'));
    var openBtn = el('button', 'btn ghost', T('Open'));
    var nameSpan = el('span', 'hint'); nameSpan.textContent = rel || T('New file');
    var status = el('span', 'hint'); status.style.marginLeft = 'auto';
    bar.appendChild(saveBtn); bar.appendChild(openBtn); bar.appendChild(nameSpan); bar.appendChild(status);
    var ta = el('textarea'); ta.style.cssText = 'flex:1;border:0;outline:0;resize:none;padding:12px;font:13px/1.5 ui-monospace,Consolas,Menlo,monospace;background:transparent;color:inherit';
    ta.spellcheck = false; wrap.appendChild(bar); wrap.appendChild(ta); body.appendChild(wrap);
    var pathRef = rel;
    if (rel) fsapi('read', { path: rel }).then(function (d) { if (d.error) { status.textContent = d.error; return; } ta.value = d.text; }).catch(function () { status.textContent = 'error'; });
    openBtn.addEventListener('click', function () { pickFile(function (abs) { openInWindow(win, abs); }); });
    saveBtn.addEventListener('click', function () {
      if (!pathRef) { var n = prompt(T('New file'), 'untitled.txt'); if (!n) return; pathRef = n; nameSpan.textContent = pathRef; }
      saveBtn.disabled = true; status.textContent = T('Saving...');
      fsapi('write', { path: pathRef, content: ta.value }).then(function (d) { saveBtn.disabled = false; status.textContent = d.error ? d.error : T('Saved.'); }).catch(function () { saveBtn.disabled = false; status.textContent = T('Failed.'); });
    });
    win.setMenus([
      { label: T('File'), items: [
        { label: T('New'), action: function () { spawnApp('texteditor:new' + seq, T('New file'), ICON.editor, 720, 560, function (b2, w2) { mountTextEditor(b2, w2, null); }); } },
        { label: T('Open') + '...', action: function () { openBtn.click(); } },
        '---',
        { label: T('Save'), accel: 'Ctrl+S', action: function () { saveBtn.click(); } }
      ] },
      { label: T('Edit'), items: [ { label: T('Select all'), action: function () { ta.focus(); ta.select(); } } ] }
    ]);
  }

  function mountCalculator(body, win) {
    var pad = el('div'); pad.style.cssText = 'height:100%;display:flex;flex-direction:column;padding:10px;gap:8px';
    var disp = el('input', 'inp'); disp.style.cssText = 'width:100%;height:48px;text-align:right;font-size:22px'; disp.readOnly = true; disp.value = '0';
    pad.appendChild(disp);
    var grid = el('div'); grid.style.cssText = 'flex:1;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:1fr;gap:8px';
    var expr = '';
    function setd() { disp.value = expr || '0'; }
    function evalExpr(s) { if (!/^[-+*/().\d\s]+$/.test(s)) throw 0; return Function('"use strict";return (' + s + ')')(); }
    ['C', '(', ')', '/', '7', '8', '9', '*', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '=', '⌫'].forEach(function (k) {
      var b = el('button', 'btn ghost', k); b.style.cssText = 'font-size:17px;height:100%';
      if (k === '=') b.className = 'btn';
      b.addEventListener('click', function () {
        if (k === 'C') { expr = ''; return setd(); }
        if (k === '⌫') { expr = expr.slice(0, -1); return setd(); }
        if (k === '=') { try { var v = evalExpr(expr); expr = String(v); } catch (e) { expr = 'Error'; } return setd(); }
        if (expr === 'Error') expr = '';
        expr += k; setd();
      });
      grid.appendChild(b);
    });
    pad.appendChild(grid); body.appendChild(pad);
  }

  function mountEmptyViewer(body, win, ca) {
    var pad = el('div', 'app-pad'); pad.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;height:100%;text-align:center';
    var ic = el('div', null, ca.iconSvg); ic.style.cssText = 'width:54px;height:54px;opacity:.75';
    pad.appendChild(ic);
    pad.appendChild(el('div', 'hint', T('No file open')));
    var b = el('button', 'btn', T('Open from File Manager'));
    b.addEventListener('click', function () { pickFile(function (abs) { openInWindow(win, abs); }); });
    pad.appendChild(b); body.appendChild(pad);
    win.setMenus([{ label: T('File'), items: [ { label: T('Open') + '...', action: function () { pickFile(function (abs) { openInWindow(win, abs); }); } } ] }]);
  }

  function mountImageViewer(body, win, rel) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column;background:#1c1c1c';
    var img = el('img'); img.src = fileUrl(rel); img.style.cssText = 'flex:1;min-height:0;object-fit:contain';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:8px;padding:6px 10px;background:#262626;color:#ccc;font-size:12px;align-items:center';
    bar.appendChild(el('span', null, rel.split('/').pop())); var sp = el('div'); sp.style.flex = '1'; bar.appendChild(sp);
    var dl = el('a', 'btn ghost', T('Download')); dl.href = fileUrl(rel, true); dl.style.cssText = 'text-decoration:none;color:#ccc'; bar.appendChild(dl);
    wrap.appendChild(img); wrap.appendChild(bar); body.appendChild(wrap);
    win.setMenus([{ label: T('File'), items: [ { label: T('Download'), action: function () { dl.click(); } }, { label: T('Open from File Manager'), action: function () { pickFile(function (abs) { openInWindow(win, abs); }); } } ] }]);
  }

  function mountMediaPlayer(body, win, rel) {
    body.style.padding = '0';
    var isAudio = /\.(mp3|wav|m4a|flac|aac|opus)$/i.test(rel);
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column;background:#0e0e0e;align-items:center;justify-content:center;gap:12px';
    if (isAudio) { var t = el('div'); t.style.cssText = 'color:#ccc'; t.textContent = rel.split('/').pop(); wrap.appendChild(t); }
    var media = el(isAudio ? 'audio' : 'video'); media.src = fileUrl(rel); media.controls = true; media.autoplay = false;
    media.style.cssText = isAudio ? 'width:90%' : 'max-width:100%;max-height:100%';
    wrap.appendChild(media); body.appendChild(wrap);
    win.setMenus([{ label: T('File'), items: [
      { label: T('Download'), action: function () { window.open(fileUrl(rel, true), '_blank'); } },
      { label: T('Open from File Manager'), action: function () { pickFile(function (abs) { openInWindow(win, abs); }); } }
    ] }]);
  }

  function mountEbook(body, win, rel) {
    if (/\.pdf$/i.test(rel)) return mountPdf(body, win, rel);
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var area = el('div'); area.style.cssText = 'flex:1;min-height:0;background:#fff';
    var nav = el('div'); nav.style.cssText = 'display:flex;gap:8px;justify-content:center;padding:6px;border-top:1px solid rgba(128,128,128,.2)';
    var prev = el('button', 'btn ghost', '‹ '); var next = el('button', 'btn ghost', ' ›');
    nav.appendChild(prev); nav.appendChild(next); wrap.appendChild(area); wrap.appendChild(nav); body.appendChild(wrap);
    win.setMenus([{ label: T('File'), items: [
      { label: T('Download'), action: function () { window.open(fileUrl(rel, true), '_blank'); } },
      { label: T('Open from File Manager'), action: function () { pickFile(function (abs) { openInWindow(win, abs); }); } }
    ] }]);
    area.appendChild(el('div', 'hint', T('Loading...')));
    loadScript('https://cdn.jsdelivr.net/npm/jszip/dist/jszip.min.js', function () {
      loadScript('https://cdn.jsdelivr.net/npm/epubjs/dist/epub.min.js', function (ok) {
        area.innerHTML = '';
        if (!ok || !window.ePub) { area.appendChild(el('div', 'hint', T('Could not open.') + ' (epub.js)')); return; }
        try {
          var book = window.ePub(fileUrl(rel));
          var rendition = book.renderTo(area, { width: '100%', height: '100%', flow: 'paginated', spread: 'none' });
          rendition.display();
          prev.addEventListener('click', function () { rendition.prev(); });
          next.addEventListener('click', function () { rendition.next(); });
        } catch (e) { area.appendChild(el('div', 'hint', T('Could not open.'))); }
      });
    });
  }

  // PDF: native viewer (embed) + real editing via pdf-lib (rotate, delete page, save a new file).
  function mountPdf(body, win, rel) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.2);align-items:center;font-size:12px;flex-wrap:wrap';
    bar.appendChild(el('span', null, rel.split('/').pop())); var sp = el('div'); sp.style.flex = '1'; bar.appendChild(sp);
    var rotBtn = el('button', 'btn ghost', '⟳ ' + T('Rotate'));
    var delBtn = el('button', 'btn ghost', T('Delete page'));
    var saveBtn = el('button', 'btn', T('Save as new file'));
    var dl = el('a', 'btn ghost', T('Download')); dl.href = fileUrl(rel, true); dl.style.cssText = 'text-decoration:none;line-height:26px';
    var msg = el('span', 'hint');
    [rotBtn, delBtn, saveBtn, dl, msg].forEach(function (e) { bar.appendChild(e); });
    var pageInfo = el('span', 'hint'); bar.insertBefore(pageInfo, sp.nextSibling);
    var pages = el('div'); pages.style.cssText = 'flex:1;overflow:auto;background:#3a3a3a;padding:10px';
    pages.appendChild(el('div', 'hint', T('Loading...')));
    wrap.appendChild(bar); wrap.appendChild(pages); body.appendChild(wrap);
    var bytes = null, pdfDoc = null;
    function ensurePdfjs(cb) {
      if (window.pdfjsLib) return cb(true);
      loadScript('https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', function (ok) {
        if (ok && window.pdfjsLib) { try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'; } catch (e) {} cb(true); } else cb(false);
      });
    }
    function renderBytes(buf) {
      ensurePdfjs(function (ok) {
        if (!ok) { pages.innerHTML = ''; pages.appendChild(el('div', 'hint', T('Could not open.') + ' (pdf.js)')); return; }
        window.pdfjsLib.getDocument({ data: buf.slice(0) }).promise.then(function (doc) {
          pages.innerHTML = ''; pageInfo.textContent = doc.numPages + 'p';
          var chain = Promise.resolve();
          for (var i = 1; i <= doc.numPages; i++) (function (pageNum) {
            chain = chain.then(function () {
              return doc.getPage(pageNum).then(function (page) {
                var vp = page.getViewport({ scale: 1.4 });
                var cv = el('canvas'); cv.width = vp.width; cv.height = vp.height;
                cv.style.cssText = 'display:block;margin:0 auto 10px;max-width:100%;box-shadow:0 2px 12px rgba(0,0,0,.5);background:#fff';
                pages.appendChild(cv);
                return page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
              });
            });
          })(i);
        }).catch(function () { pages.innerHTML = ''; pages.appendChild(el('div', 'hint', T('Could not open.'))); });
      });
    }
    fetch(fileUrl(rel)).then(function (r) { return r.arrayBuffer(); }).then(function (buf) { bytes = buf; renderBytes(buf); }).catch(function () { pages.innerHTML = ''; pages.appendChild(el('div', 'hint', T('Could not open.'))); });
    function ensureLib(cb) { if (window.PDFLib) return cb(true); msg.textContent = '...'; loadScript('https://cdn.jsdelivr.net/npm/pdf-lib/dist/pdf-lib.min.js', function (ok) { msg.textContent = ''; cb(ok && !!window.PDFLib); }); }
    function ensureDoc(cb) { if (pdfDoc) return cb(); ensureLib(function (ok) { if (!ok || !bytes) { msg.textContent = T('Could not open.'); return; } window.PDFLib.PDFDocument.load(bytes.slice(0)).then(function (d) { pdfDoc = d; cb(); }).catch(function () { msg.textContent = T('Could not open.'); }); }); }
    function reflow() { pdfDoc.save().then(function (b) { bytes = b; renderBytes(b); }); }
    rotBtn.addEventListener('click', function () { ensureDoc(function () { pdfDoc.getPages().forEach(function (p) { p.setRotation(window.PDFLib.degrees((p.getRotation().angle + 90) % 360)); }); msg.textContent = 'rotated'; reflow(); }); });
    delBtn.addEventListener('click', function () { ensureDoc(function () { var n = parseInt(prompt('Delete which page? (1-' + pdfDoc.getPageCount() + ')'), 10); if (!n || n < 1 || n > pdfDoc.getPageCount()) return; pdfDoc.removePage(n - 1); msg.textContent = 'page removed'; reflow(); }); });
    saveBtn.addEventListener('click', function () {
      ensureDoc(function () {
        var out = rel.replace(/\.pdf$/i, '') + '-edited.pdf';
        msg.textContent = T('Saving...');
        pdfDoc.save().then(function (b) { return fsapi('writeB64', { path: out, content: bytesToB64(b) }); }).then(function (d) { msg.textContent = d && d.error ? d.error : (T('Saved.') + ' ' + out); }).catch(function () { msg.textContent = T('Failed.'); });
      });
    });
    win.setMenus([
      { label: T('File'), items: [ { label: T('Download'), action: function () { dl.click(); } }, { label: T('Save as new file'), action: function () { saveBtn.click(); } } ] },
      { label: T('Page'), items: [ { label: T('Rotate'), action: function () { rotBtn.click(); } }, { label: T('Delete page'), action: function () { delBtn.click(); } } ] }
    ]);
  }

  // Document viewer/editor: Word (render via mammoth, edit + save back to .docx) and
  // Excel (render via SheetJS server-side, edit cells + save back to .xlsx client-side).
  function mountDocViewer(body, win, rel, kind) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(128,128,128,.2);align-items:center;font-size:12px;flex-wrap:wrap';
    bar.appendChild(el('span', null, rel.split('/').pop())); var sp = el('div'); sp.style.flex = '1'; bar.appendChild(sp);
    var editBtn = el('button', 'btn ghost', T('Edit'));
    var saveBtn = el('button', 'btn', T('Save')); saveBtn.style.display = 'none';
    var dl = el('a', 'btn ghost', T('Download')); dl.href = fileUrl(rel, true); dl.style.cssText = 'text-decoration:none;line-height:26px';
    var msg = el('span', 'hint');
    [editBtn, saveBtn, dl, msg].forEach(function (e) { bar.appendChild(e); });
    var content = el('div'); content.style.cssText = 'flex:1;overflow:auto;padding:16px;background:#fff;color:#111';
    content.appendChild(el('div', 'hint', T('Loading...')));
    wrap.appendChild(bar); wrap.appendChild(content); body.appendChild(wrap);
    var editing = false;
    api('/api/docview?path=' + encodeURIComponent(rel)).then(function (d) {
      content.innerHTML = '';
      if (d.error) { content.appendChild(el('div', 'hint', d.error)); editBtn.style.display = 'none'; return; }
      if (d.kind === 'doc') { var box = el('div', 'docview-doc'); box.innerHTML = d.html; content.appendChild(box); win._docBox = box; }
      else if (d.kind === 'sheet') { d.sheets.forEach(function (sh) { content.appendChild(el('h3', null, sh.name)); var b2 = el('div', 'docview-sheet'); b2.innerHTML = sh.html; content.appendChild(b2); }); }
    }).catch(function () { content.innerHTML = ''; content.appendChild(el('div', 'hint', T('Could not open.'))); });
    editBtn.addEventListener('click', function () {
      editing = !editing;
      var targets = content.querySelectorAll(kind === 'sheet' ? 'table' : '.docview-doc');
      Array.prototype.forEach.call(targets, function (t) { t.setAttribute('contenteditable', editing ? 'true' : 'false'); t.style.outline = editing ? '1px dashed #3a7bd5' : ''; });
      editBtn.textContent = editing ? T('Close') : T('Edit'); saveBtn.style.display = editing ? '' : 'none';
    });
    saveBtn.addEventListener('click', function () {
      msg.textContent = T('Saving...'); saveBtn.disabled = true;
      if (kind === 'doc') {
        var html = (content.querySelector('.docview-doc') || {}).innerHTML || '';
        api('/api/docwrite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: rel, html: html }) })
          .then(function (d) { saveBtn.disabled = false; msg.textContent = d && d.error ? d.error : (T('Saved.') + (d.path ? ' ' + d.path : '')); }).catch(function () { saveBtn.disabled = false; msg.textContent = T('Failed.'); });
      } else {
        loadScript('https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js', function (ok) {
          if (!ok || !window.XLSX) { saveBtn.disabled = false; msg.textContent = T('Failed.'); return; }
          try {
            var wb = window.XLSX.utils.book_new();
            var tables = content.querySelectorAll('table'); var hs = content.querySelectorAll('h3');
            Array.prototype.forEach.call(tables, function (tb, i) { var ws = window.XLSX.utils.table_to_sheet(tb); var nm = (hs[i] && hs[i].textContent || ('Sheet' + (i + 1))).slice(0, 31); window.XLSX.utils.book_append_sheet(wb, ws, nm); });
            var out = rel.replace(/\.(xlsx?|ods)$/i, '') + '-edited.xlsx';
            var b64 = window.XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
            fsapi('writeB64', { path: out, content: b64 }).then(function (d) { saveBtn.disabled = false; msg.textContent = d && d.error ? d.error : (T('Saved.') + ' ' + out); }).catch(function () { saveBtn.disabled = false; msg.textContent = T('Failed.'); });
          } catch (e) { saveBtn.disabled = false; msg.textContent = T('Failed.'); }
        });
      }
    });
    win.setMenus([
      { label: T('File'), items: [ { label: T('Download'), action: function () { dl.click(); } }, { label: T('Save'), action: function () { saveBtn.click(); } } ] },
      { label: T('Edit'), items: [ { label: T('Edit'), action: function () { editBtn.click(); } } ] }
    ]);
  }

  // Telnet / raw-TCP terminal over the /telnet WebSocket bridge.
  function mountTelnet(body, win) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;padding:8px;border-bottom:1px solid rgba(128,128,128,.2);align-items:center;flex-wrap:wrap';
    var host = el('input', 'inp'); host.placeholder = 'host'; host.style.flex = '1';
    var port = el('input', 'inp'); port.placeholder = '23'; port.value = '23'; port.style.width = '70px';
    var connBtn = el('button', 'btn', 'Connect');
    bar.appendChild(host); bar.appendChild(port); bar.appendChild(connBtn);
    var term = el('div'); term.style.cssText = 'flex:1;overflow:auto;background:#0b0b0b;color:#cfffd0;font:13px/1.45 ui-monospace,Consolas,Menlo,monospace;padding:10px;white-space:pre-wrap;word-break:break-all';
    var inp = el('input', 'inp'); inp.placeholder = 'type a line and press Enter'; inp.disabled = true; inp.style.cssText = 'border:0;border-top:1px solid rgba(128,128,128,.2);border-radius:0';
    wrap.appendChild(bar); wrap.appendChild(term); wrap.appendChild(inp); body.appendChild(wrap);
    var sock = null;
    function append(s) { term.appendChild(document.createTextNode(s)); term.scrollTop = term.scrollHeight; }
    function connect() {
      if (!host.value.trim()) return;
      var proto = location.protocol === 'https:' ? 'wss' : 'ws';
      sock = new WebSocket(proto + '://' + location.host + '/telnet?host=' + encodeURIComponent(host.value.trim()) + '&port=' + encodeURIComponent(port.value || '23') + '&token=');
      sock.binaryType = 'arraybuffer';
      sock.onopen = function () { inp.disabled = false; connBtn.textContent = 'Disconnect'; inp.focus(); };
      sock.onmessage = function (ev) { append(typeof ev.data === 'string' ? ev.data : new TextDecoder('latin1').decode(new Uint8Array(ev.data))); };
      sock.onclose = function () { inp.disabled = true; connBtn.textContent = 'Connect'; sock = null; };
      sock.onerror = function () { append('\n[connection error]\n'); };
    }
    connBtn.addEventListener('click', function () { if (sock) { try { sock.close(); } catch (e) {} } else connect(); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (sock && sock.readyState === 1) { sock.send(inp.value + '\r\n'); append(inp.value + '\n'); } inp.value = ''; } });
    win.setMenus([{ label: T('Session'), items: [
      { label: T('Connect'), action: function () { if (!sock) connect(); } },
      { label: T('Disconnect'), action: function () { if (sock) { try { sock.close(); } catch (e) {} } } }
    ] }]);
    win.cleanup.push(function () { if (sock) { try { sock.close(); } catch (e) {} } });
  }

  // SFTP client: real SSH/SFTP sessions via the /api/sftp backend (ssh2). Browse, download, upload, manage.
  function mountSftp(body, win) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column;font-size:13px';
    var form = el('div'); form.style.cssText = 'display:flex;gap:6px;padding:8px;border-bottom:1px solid rgba(128,128,128,.2);flex-wrap:wrap;align-items:center';
    var host = el('input', 'inp'); host.placeholder = 'host'; host.style.flex = '2';
    var port = el('input', 'inp'); port.placeholder = '22'; port.value = '22'; port.style.width = '56px';
    var user = el('input', 'inp'); user.placeholder = 'username'; user.style.flex = '1';
    var pass = el('input', 'inp'); pass.type = 'password'; pass.placeholder = 'password'; pass.style.flex = '1';
    var connBtn = el('button', 'btn', 'Connect');
    [host, port, user, pass, connBtn].forEach(function (e) { form.appendChild(e); });
    var bar = el('div'); bar.style.cssText = 'display:none;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(128,128,128,.2);align-items:center;flex-wrap:wrap';
    var upBtn = el('button', 'btn ghost', '↰'); var pathInp = el('input', 'inp'); pathInp.style.flex = '1';
    var refBtn = el('button', 'btn ghost', T('Refresh')); var mkBtn = el('button', 'btn ghost', T('New folder')); var ulBtn = el('button', 'btn ghost', '📎'); var dcBtn = el('button', 'btn ghost', 'Disconnect');
    var fileIn = el('input'); fileIn.type = 'file'; fileIn.style.display = 'none';
    [upBtn, pathInp, refBtn, mkBtn, ulBtn, dcBtn].forEach(function (e) { bar.appendChild(e); });
    var list = el('div'); list.style.cssText = 'flex:1;overflow:auto;padding:6px';
    var status = el('div', 'hint'); status.style.cssText = 'padding:4px 8px;border-top:1px solid rgba(128,128,128,.2)';
    wrap.appendChild(form); wrap.appendChild(bar); wrap.appendChild(list); wrap.appendChild(status); body.appendChild(wrap); body.appendChild(fileIn);
    var sid = null, cur = '.';
    function sapi(op, extra) { return api('/api/sftp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ op: op, sessionId: sid }, extra || {})) }); }
    function parent(p) { if (p === '/' || p === '.' || p === '') return p; var q = p.replace(/\/+$/, ''); var i = q.lastIndexOf('/'); return i <= 0 ? '/' : q.slice(0, i); }
    function join(p, n) { if (p === '.') return n; return (p === '/' ? '' : p.replace(/\/+$/, '')) + '/' + n; }
    function load(p) {
      status.textContent = '...'; sapi('list', { path: p }).then(function (d) {
        if (d.error) { status.textContent = d.error; return; }
        cur = p; pathInp.value = p; list.innerHTML = '';
        d.items.forEach(function (it) {
          var full = join(p, it.name);
          var row = el('div', 'fm-row');
          var ic = el('span', 'fm-ico', it.dir ? ICON.files : iconForName(it.name));
          var nm = el('span'); nm.textContent = it.name; nm.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          var meta = el('span', 'hint'); meta.textContent = it.dir ? '' : humanSize(it.size);
          var act = el('span', 'fm-act');
          if (!it.dir) { var dl = el('button', 'btn ghost mini', T('Download')); dl.addEventListener('click', function (e) { e.stopPropagation(); status.textContent = '...'; sapi('read', { path: full }).then(function (r) { if (r.error) { status.textContent = r.error; return; } var a = document.createElement('a'); a.href = 'data:application/octet-stream;base64,' + r.b64; a.download = it.name; a.click(); status.textContent = 'downloaded ' + it.name; }); }); act.appendChild(dl); }
          var rn = el('button', 'btn ghost mini', T('Rename')); rn.addEventListener('click', function (e) { e.stopPropagation(); var nn = prompt(T('Rename'), it.name); if (nn && nn !== it.name) sapi('rename', { path: full, to: join(parent(full) === full ? cur : parent(full), nn) }).then(function () { load(cur); }); }); act.appendChild(rn);
          var del = el('button', 'btn ghost mini', T('Delete')); del.addEventListener('click', function (e) { e.stopPropagation(); if (confirm(T('Delete') + ' "' + it.name + '"?')) sapi('delete', { path: full }).then(function () { load(cur); }); }); act.appendChild(del);
          row.appendChild(ic); row.appendChild(nm); row.appendChild(meta); row.appendChild(act);
          row.addEventListener('dblclick', function () { if (it.dir) load(full); });
          list.appendChild(row);
        });
        status.textContent = d.items.length + ' items · ' + p;
      }).catch(function () { status.textContent = 'error'; });
    }
    connBtn.addEventListener('click', function () {
      if (sid) return; connBtn.disabled = true; status.textContent = 'connecting...';
      sapi('connect', { host: host.value.trim(), port: port.value || '22', username: user.value.trim(), password: pass.value }).then(function (d) {
        connBtn.disabled = false; if (d.error) { status.textContent = d.error; return; }
        sid = d.sessionId; pass.value = ''; form.style.display = 'none'; bar.style.display = 'flex'; load('.');
      }).catch(function () { connBtn.disabled = false; status.textContent = 'connect failed'; });
    });
    upBtn.addEventListener('click', function () { load(parent(cur)); });
    refBtn.addEventListener('click', function () { load(cur); });
    pathInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(pathInp.value); });
    mkBtn.addEventListener('click', function () { var n = prompt(T('New folder')); if (n) sapi('mkdir', { path: join(cur, n) }).then(function () { load(cur); }); });
    ulBtn.addEventListener('click', function () { fileIn.click(); });
    fileIn.addEventListener('change', function () { var f = (fileIn.files || [])[0]; fileIn.value = ''; if (!f) return; var rd = new FileReader(); rd.onload = function () { var s = String(rd.result || ''); var c = s.indexOf(','); var b64 = c >= 0 ? s.slice(c + 1) : s; status.textContent = 'uploading...'; sapi('write', { path: join(cur, f.name), content: b64 }).then(function () { load(cur); }); }; rd.readAsDataURL(f); });
    dcBtn.addEventListener('click', function () { if (sid) sapi('disconnect', {}); sid = null; bar.style.display = 'none'; form.style.display = 'flex'; list.innerHTML = ''; status.textContent = ''; });
    win.setMenus([
      { label: T('Session'), items: [ { label: T('Connect'), action: function () { connBtn.click(); } }, { label: T('Disconnect'), action: function () { dcBtn.click(); } } ] },
      { label: T('File'), items: [ { label: T('New folder'), action: function () { mkBtn.click(); } }, { label: T('Upload') + '...', action: function () { ulBtn.click(); } }, { label: T('Refresh'), action: function () { refBtn.click(); } } ] }
    ]);
    win.cleanup.push(function () { if (sid) sapi('disconnect', {}); });
  }

  // Messages: a real client for the connected messaging channels (Telegram/Discord/Slack/Signal/
  // WhatsApp/email). Lists channels, shows each channel's real message history, and sends replies.
  function mountMessages(body, win) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;font-size:13px';
    var side = el('div'); side.style.cssText = 'width:164px;flex:0 0 auto;border-right:1px solid rgba(128,128,128,.2);overflow:auto;padding:6px';
    var main = el('div'); main.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0';
    var head = el('div', 'hint'); head.style.cssText = 'padding:8px 10px;border-bottom:1px solid rgba(128,128,128,.2)';
    var log = el('div'); log.style.cssText = 'flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:6px';
    var composer = el('div'); composer.style.cssText = 'display:none;gap:6px;padding:8px;border-top:1px solid rgba(128,128,128,.2)';
    var chatIn = el('input', 'inp'); chatIn.placeholder = 'chat id'; chatIn.style.cssText = 'width:104px;flex:0 0 auto';
    var ta = el('input', 'inp'); ta.placeholder = T('Message') + '...'; ta.style.flex = '1';
    var send = el('button', 'btn', T('Send'));
    composer.appendChild(chatIn); composer.appendChild(ta); composer.appendChild(send);
    main.appendChild(head); main.appendChild(log); main.appendChild(composer);
    wrap.appendChild(side); wrap.appendChild(main); body.appendChild(wrap);
    var current = null, timer = null;
    function select(name) { current = name; head.textContent = name; composer.style.display = 'flex'; Array.prototype.forEach.call(side.children, function (c) { c.classList.toggle('active', c.dataset.ch === name); }); chatIn.value = ''; refresh(); }
    function loadChannels() {
      api('/api/channels').then(function (d) {
        side.innerHTML = ''; var chs = d.channels || [];
        if (!chs.length) { head.textContent = 'No messaging channels connected. Enable Telegram, Discord, Slack, Signal, WhatsApp or email in Settings — connected channels and their conversations appear here.'; side.appendChild(el('div', 'hint', '—')); return; }
        chs.forEach(function (c) { var b = el('div', 'sm-row'); b.dataset.ch = c.name; b.appendChild(el('div', 'label', c.name + (c.running ? '' : ' (off)'))); b.addEventListener('click', function () { select(c.name); }); side.appendChild(b); });
        if (!current) select(chs[0].name);
      }).catch(function () { side.innerHTML = ''; side.appendChild(el('div', 'hint', 'error')); });
    }
    function refresh() {
      if (!current) return;
      api('/api/channels/messages?channel=' + encodeURIComponent(current)).then(function (d) {
        log.innerHTML = ''; var msgs = d.messages || []; var lastChat = '';
        if (!msgs.length) log.appendChild(el('div', 'hint', 'No messages yet on ' + current + '.'));
        msgs.forEach(function (m) {
          lastChat = m.chatId;
          var row = el('div', 'msg ' + (m.dir === 'out' ? 'user' : 'bot'));
          row.appendChild(el('div', 'who', (m.dir === 'out' ? '→ ' : '') + (m.from || m.chatId || '') + (m.chatId ? ' · ' + m.chatId : '')));
          var c = el('div'); c.textContent = m.text; row.appendChild(c); log.appendChild(row);
        });
        log.scrollTop = log.scrollHeight;
        if (lastChat && !chatIn.value) chatIn.value = lastChat;
      }).catch(function () {});
    }
    function doSend() { var t = ta.value.trim(), cid = chatIn.value.trim(); if (!t || !cid || !current) return; ta.value = ''; api('/api/channels/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: current, chatId: cid, text: t }) }).then(function (r) { if (r && r.ok) refresh(); else head.textContent = (r && r.error) || 'send failed'; }); }
    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSend(); } });
    loadChannels(); timer = setInterval(function () { if (!win.closed) refresh(); }, 5000);
    win.setMenus([{ label: T('View'), items: [ { label: T('Refresh'), accel: 'F5', action: function () { loadChannels(); refresh(); } } ] }]);
    win.cleanup.push(function () { if (timer) clearInterval(timer); });
  }

  // ============================================================
  // Local-data apps: Outlook (mail/calendar/contacts/tasks), Notes, Database, History
  // ============================================================
  function localApi(fn, args) { return api('/api/local', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fn: fn, args: args || {} }) }); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function tabBar(tabs, onPick) {
    var bar = el('div', 'app-tabs');
    var btns = {};
    tabs.forEach(function (t) { var b = el('button', 'app-tab', t[1]); btns[t[0]] = b; b.addEventListener('click', function () { Object.keys(btns).forEach(function (k) { btns[k].classList.toggle('active', k === t[0]); }); onPick(t[0]); }); bar.appendChild(b); });
    return { bar: bar, select: function (id) { if (btns[id]) btns[id].click(); } };
  }

  function mountOutlook(body, win) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var content = el('div'); content.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';
    var tabs = tabBar([['mail', T('Mail')], ['calendar', T('Calendar')], ['contacts', T('Contacts')], ['tasks', T('Tasks')]], function (t) { render(t); });
    wrap.appendChild(tabs.bar); wrap.appendChild(content); body.appendChild(wrap);
    function busy() { content.innerHTML = ''; content.appendChild(el('div', 'hint', T('Loading...') + '')); content.firstChild.style.padding = '16px'; }
    function err(m) { content.innerHTML = ''; var e = el('div', 'hint', esc(m)); e.style.padding = '16px'; content.appendChild(e); }
    function render(tab) {
      busy();
      if (tab === 'mail') return renderMail();
      if (tab === 'calendar') return localApi('outlook_pim', { action: 'calendar', days: 7 }).then(function (d) {
        if (d.error) return err(d.error);
        content.innerHTML = ''; var box = el('div'); box.style.cssText = 'overflow:auto;padding:10px';
        var byDay = {};
        (d.events || []).forEach(function (e2) { var day = (e2.start || '').slice(0, 10); (byDay[day] = byDay[day] || []).push(e2); });
        var days = Object.keys(byDay).sort();
        if (!days.length) box.appendChild(el('div', 'hint', 'No events in the next 7 days.'));
        days.forEach(function (day) {
          box.appendChild(el('div', 'ol-dayhead', day));
          byDay[day].forEach(function (e2) {
            var row = el('div', 'ol-event');
            row.innerHTML = "<span class='ol-time'>" + (e2.allDay ? 'all day' : esc((e2.start || '').slice(11)) + '–' + esc((e2.end || '').slice(11))) + "</span> <b>" + esc(e2.subject) + "</b>" + (e2.location ? " <span class='hint'>@ " + esc(e2.location) + "</span>" : '');
            box.appendChild(row);
          });
        });
        content.appendChild(box);
      }).catch(function () { err('error'); });
      if (tab === 'contacts') {
        content.innerHTML = '';
        var sb = el('div'); sb.style.cssText = 'padding:8px;border-bottom:1px solid rgba(128,128,128,.2)';
        var inp = el('input', 'inp'); inp.placeholder = T('Search') + '...'; inp.style.width = '100%'; sb.appendChild(inp);
        var list = el('div'); list.style.cssText = 'flex:1;overflow:auto;padding:8px';
        content.appendChild(sb); content.appendChild(list);
        function go() { list.innerHTML = '<div class="hint">' + T('Loading...') + '</div>'; localApi('outlook_pim', { action: 'contacts', query: inp.value.trim(), count: 100 }).then(function (d) { list.innerHTML = ''; if (d.error) return list.appendChild(el('div', 'hint', esc(d.error))); (d.contacts || []).forEach(function (c) { var r = el('div', 'ol-contact'); r.innerHTML = '<b>' + esc(c.name) + '</b>' + (c.company ? ' <span class="hint">' + esc(c.company) + '</span>' : '') + '<br><span class="hint">' + esc(c.email) + (c.phone ? ' · ' + esc(c.phone) : '') + (c.mobile ? ' · ' + esc(c.mobile) : '') + '</span>'; list.appendChild(r); }); if (!list.children.length) list.appendChild(el('div', 'hint', 'No contacts.')); }); }
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); }); go();
        return;
      }
      if (tab === 'tasks') return localApi('outlook_pim', { action: 'tasks', count: 100 }).then(function (d) { content.innerHTML = ''; if (d.error) return err(d.error); var box = el('div'); box.style.cssText = 'overflow:auto;padding:10px'; (d.tasks || []).forEach(function (t) { var r = el('div', 'ol-event'); r.innerHTML = '☐ ' + esc(t.subject) + (t.due ? ' <span class="hint">due ' + esc(t.due) + '</span>' : ''); box.appendChild(r); }); if (!box.children.length) box.appendChild(el('div', 'hint', 'No open tasks.')); content.appendChild(box); });
    }
    function renderMail() {
      var split = el('div'); split.style.cssText = 'flex:1;min-height:0;display:flex';
      var listWrap = el('div'); listWrap.style.cssText = 'width:46%;min-width:240px;border-right:1px solid rgba(128,128,128,.2);display:flex;flex-direction:column';
      var ctl = el('div'); ctl.style.cssText = 'display:flex;gap:6px;padding:6px;border-bottom:1px solid rgba(128,128,128,.2);align-items:center';
      var unreadTog = el('button', 'btn ghost', 'Unread'); var refl = el('button', 'btn ghost', T('Refresh')); var srch = el('input', 'inp'); srch.placeholder = T('Search'); srch.style.cssText = 'flex:1;min-width:60px';
      ctl.appendChild(unreadTog); ctl.appendChild(srch); ctl.appendChild(refl);
      var list = el('div'); list.style.cssText = 'flex:1;overflow:auto';
      listWrap.appendChild(ctl); listWrap.appendChild(list);
      var pane = el('div'); pane.style.cssText = 'flex:1;overflow:auto;padding:14px';
      pane.appendChild(el('div', 'hint', 'Select a message.'));
      content.innerHTML = ''; split.appendChild(listWrap); split.appendChild(pane); content.appendChild(split);
      var unread = false; unreadTog.addEventListener('click', function () { unread = !unread; unreadTog.classList.toggle('on', unread); load(); });
      refl.addEventListener('click', load); srch.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
      function load() {
        list.innerHTML = '<div class="hint" style="padding:10px">' + T('Loading...') + '</div>';
        var q = srch.value.trim();
        localApi('outlook_mail', q ? { action: 'search', query: q, count: 40 } : { action: 'list', unreadOnly: unread, count: 40 }).then(function (d) {
          list.innerHTML = ''; if (d.error) { list.appendChild(el('div', 'hint', esc(d.error))); return; }
          (d.messages || []).forEach(function (m) {
            var r = el('div', 'ol-msg' + (m.unread ? ' unread' : ''));
            r.innerHTML = "<div class='ol-from'>" + esc(m.from) + "</div><div class='ol-subj'>" + esc(m.subject) + "</div><div class='hint'>" + esc(m.received) + "</div>";
            r.addEventListener('click', function () { Array.prototype.forEach.call(list.children, function (c) { c.classList.remove('sel'); }); r.classList.add('sel'); open(m.id); });
            list.appendChild(r);
          });
          if (!list.children.length) list.appendChild(el('div', 'hint', 'No messages.'));
        }).catch(function () { list.innerHTML = '<div class="hint">error</div>'; });
      }
      function open(id) {
        pane.innerHTML = '<div class="hint">' + T('Loading...') + '</div>';
        localApi('outlook_mail', { action: 'read', id: id }).then(function (d) {
          pane.innerHTML = ''; if (d.error || !d.message) { pane.appendChild(el('div', 'hint', esc(d.error || 'not found'))); return; }
          var m = d.message;
          var h = el('div'); h.innerHTML = "<div style='font-size:16px;font-weight:650;margin-bottom:6px'>" + esc(m.subject) + "</div><div class='hint'>From: " + esc(m.from) + " &lt;" + esc(m.fromAddr) + "&gt;</div><div class='hint'>To: " + esc(m.to) + "</div><div class='hint' style='margin-bottom:10px'>" + esc(m.received) + "</div>";
          var b = el('div'); b.style.cssText = 'white-space:pre-wrap;font-size:13px;line-height:1.5'; b.textContent = m.body || '';
          pane.appendChild(h); pane.appendChild(b);
        });
      }
      load();
    }
    tabs.select('mail');
    win.setMenus([{ label: T('View'), items: [{ label: T('Mail'), action: function () { tabs.select('mail'); } }, { label: T('Calendar'), action: function () { tabs.select('calendar'); } }, { label: T('Contacts'), action: function () { tabs.select('contacts'); } }, { label: T('Tasks'), action: function () { tabs.select('tasks'); } }] }]);
  }

  function mountNotes(body, win) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex';
    var side = el('div'); side.style.cssText = 'width:280px;flex:0 0 auto;border-right:1px solid rgba(128,128,128,.2);display:flex;flex-direction:column';
    var sb = el('div'); sb.style.cssText = 'padding:6px;border-bottom:1px solid rgba(128,128,128,.2)';
    var srch = el('input', 'inp'); srch.placeholder = T('Search') + '...'; srch.style.width = '100%'; sb.appendChild(srch);
    var list = el('div'); list.style.cssText = 'flex:1;overflow:auto;padding:4px';
    side.appendChild(sb); side.appendChild(list);
    var pane = el('div', 'docview-doc'); pane.style.cssText = 'flex:1;overflow:auto;padding:16px;background:#fff;color:#111';
    pane.appendChild(el('div', 'hint', 'Select a page.'));
    wrap.appendChild(side); wrap.appendChild(pane); body.appendChild(wrap);
    function open(id) { pane.innerHTML = '<div class="hint">' + T('Loading...') + '</div>'; localApi('onenote', { action: 'read', id: id }).then(function (d) { pane.innerHTML = ''; if (d.error) return pane.appendChild(el('div', 'hint', esc(d.error))); pane.appendChild(el('h2', null, esc(d.title || ''))); var b = el('div'); b.style.cssText = 'white-space:pre-wrap'; b.textContent = d.text || '(empty page)'; pane.appendChild(b); }); }
    function load(q) {
      list.innerHTML = '<div class="hint">' + T('Loading...') + '</div>';
      localApi('onenote', q ? { action: 'search', query: q } : { action: 'notebooks' }).then(function (d) {
        list.innerHTML = ''; if (d.error) { list.appendChild(el('div', 'hint', esc(d.error))); return; }
        (d.pages || []).forEach(function (p) { var r = el('div', 'fm-row'); r.innerHTML = "<div style='flex:1;overflow:hidden'><div>" + esc(p.page) + "</div><div class='hint' style='font-size:11px'>" + esc(p.notebook) + ' / ' + esc(p.section) + "</div></div>"; r.style.cursor = 'pointer'; r.addEventListener('click', function () { open(p.id); }); list.appendChild(r); });
        if (!list.children.length) list.appendChild(el('div', 'hint', q ? 'No pages match.' : 'No pages found.'));
      });
    }
    srch.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(srch.value.trim()); });
    load(''); win.setMenus([{ label: T('View'), items: [{ label: T('Refresh'), action: function () { load(srch.value.trim()); } }] }]);
  }

  function mountDatabase(body, win) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;padding:8px;border-bottom:1px solid rgba(128,128,128,.2);flex-wrap:wrap;align-items:center';
    var connSel = el('select', 'inp'); connSel.style.width = '170px'; connSel.title = 'Connection';
    var server = el('input', 'inp'); server.value = '(localdb)\\MSSQLLocalDB'; server.style.cssText = 'width:190px'; server.title = 'Server / instance';
    var dbsel = el('select', 'inp'); dbsel.style.width = '150px'; var optAll = el('option'); optAll.value = ''; optAll.textContent = '(database)'; dbsel.appendChild(optAll);
    var addBtn = el('button', 'btn ghost', '+'); addBtn.title = 'Add connection';
    var rmBtn = el('button', 'btn ghost', '🗑'); rmBtn.title = 'Remove connection'; rmBtn.style.display = 'none';
    var runBtn = el('button', 'btn', '▶ ' + T('Run')); var status = el('span', 'hint');
    [connSel, addBtn, rmBtn, server, dbsel, runBtn, status].forEach(function (e) { bar.appendChild(e); });
    // Add-connection form (hidden until +)
    var form = el('div'); form.style.cssText = 'display:none;gap:6px;padding:8px;border-bottom:1px solid rgba(128,128,128,.2);flex-wrap:wrap;align-items:center;background:rgba(0,103,192,.06)';
    var fName = el('input', 'inp'); fName.placeholder = 'name'; fName.style.width = '120px';
    var fServer = el('input', 'inp'); fServer.placeholder = 'server\\instance'; fServer.style.width = '190px';
    var fDb = el('input', 'inp'); fDb.placeholder = 'database (optional)'; fDb.style.width = '150px';
    var fUser = el('input', 'inp'); fUser.placeholder = 'user (blank = Windows auth)'; fUser.style.width = '150px';
    var fPass = el('input', 'inp'); fPass.type = 'password'; fPass.placeholder = 'password'; fPass.style.width = '130px';
    var fSave = el('button', 'btn', T('Save')); var fCancel = el('button', 'btn ghost', T('Close'));
    [fName, fServer, fDb, fUser, fPass, fSave, fCancel].forEach(function (e) { form.appendChild(e); });
    var qa = el('textarea'); qa.style.cssText = 'height:90px;border:0;border-bottom:1px solid rgba(128,128,128,.2);outline:0;resize:vertical;padding:10px;font:13px/1.4 ui-monospace,Consolas,monospace;background:transparent;color:inherit'; qa.spellcheck = false; qa.value = 'SELECT name FROM sys.databases';
    var grid = el('div'); grid.style.cssText = 'flex:1;overflow:auto;padding:8px';
    wrap.appendChild(bar); wrap.appendChild(form); wrap.appendChild(qa); wrap.appendChild(grid); body.appendChild(wrap);

    function curConn() { return connSel.value || ''; }
    function adhoc() { return !curConn(); }
    function baseArgs() { return adhoc() ? { server: server.value.trim() } : { connection: curConn() }; }
    function syncControls() { var ah = adhoc(); server.style.display = ah ? '' : 'none'; rmBtn.style.display = ah ? 'none' : ''; }
    function loadConns(sel) {
      localApi('sql_connections', {}).then(function (d) {
        connSel.innerHTML = ''; var o0 = el('option'); o0.value = ''; o0.textContent = 'Ad-hoc'; connSel.appendChild(o0);
        (d.connections || []).forEach(function (c) { var o = el('option'); o.value = c.name; o.textContent = c.name + (c.user ? ' (' + c.user + ')' : ''); connSel.appendChild(o); });
        if (sel) connSel.value = sel;
        syncControls(); loadDbs();
      });
    }
    function loadDbs() {
      dbsel.innerHTML = ''; dbsel.appendChild(optAll); optAll.value = ''; optAll.textContent = '(database)';
      localApi('sql', Object.assign({ query: 'SELECT name FROM sys.databases ORDER BY name' }, baseArgs())).then(function (d) { (d.rows || []).forEach(function (r) { var o = el('option'); o.value = r[0]; o.textContent = r[0]; dbsel.appendChild(o); }); });
    }
    function run() {
      runBtn.disabled = true; status.textContent = T('Loading...'); grid.innerHTML = '';
      var args = Object.assign({ query: qa.value, database: dbsel.value || undefined }, baseArgs());
      localApi('sql', args).then(function (d) {
        runBtn.disabled = false; status.textContent = d.note || '';
        if (d.error) { grid.appendChild(el('div', 'hint', esc(d.error))); return; }
        var cols = d.columns || [], rows = d.rows || [];
        if (!cols.length) { grid.appendChild(el('div', 'hint', T('no rows'))); return; }
        var html = "<table class='sql-grid'><thead><tr>" + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + "</tr></thead><tbody>";
        html += rows.map(function (r) { return '<tr>' + r.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>'; }).join('');
        html += '</tbody></table>'; grid.innerHTML = html;
      }).catch(function () { runBtn.disabled = false; status.textContent = 'error'; });
    }
    connSel.addEventListener('change', function () { syncControls(); loadDbs(); });
    server.addEventListener('change', loadDbs);
    runBtn.addEventListener('click', run);
    addBtn.addEventListener('click', function () { form.style.display = form.style.display === 'none' ? 'flex' : 'none'; });
    fCancel.addEventListener('click', function () { form.style.display = 'none'; });
    fSave.addEventListener('click', function () {
      if (!fName.value.trim() || !fServer.value.trim()) { status.textContent = 'name + server required'; return; }
      localApi('sql_conn_add', { name: fName.value.trim(), server: fServer.value.trim(), database: fDb.value.trim() || undefined, user: fUser.value.trim() || undefined, password: fPass.value || undefined }).then(function (r) {
        if (r && r.error) { status.textContent = r.error; return; }
        var nm = fName.value.trim(); fName.value = fServer.value = fDb.value = fUser.value = fPass.value = ''; form.style.display = 'none'; loadConns(nm);
      });
    });
    rmBtn.addEventListener('click', function () { var n = curConn(); if (n && confirm(T('Delete') + ' "' + n + '"?')) localApi('sql_conn_remove', { name: n }).then(function () { loadConns(''); }); });
    qa.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } });
    win.setMenus([
      { label: T('Query'), items: [{ label: '▶ ' + T('Run'), accel: 'Ctrl+Enter', action: run }, { label: 'Databases', action: function () { qa.value = 'SELECT name FROM sys.databases'; run(); } }, { label: 'Tables', action: function () { qa.value = 'SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ORDER BY 1,2'; run(); } }] },
      { label: 'Connection', items: [{ label: '+ Add connection', action: function () { form.style.display = 'flex'; fName.focus(); } }, { label: 'Remove current', action: function () { rmBtn.click(); } }] }
    ]);
    loadConns(''); run();
  }

  function mountBrowserHistory(body, win) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:6px;padding:8px;border-bottom:1px solid rgba(128,128,128,.2);align-items:center;flex-wrap:wrap';
    var srch = el('input', 'inp'); srch.placeholder = T('Search') + '...'; srch.style.cssText = 'flex:1;min-width:120px';
    var seg = tabBar([['history', T('History')], ['bookmarks', T('Bookmarks')]], function (w) { mode = w; load(); });
    var br = el('select', 'inp'); ['', 'chrome', 'edge', 'firefox'].forEach(function (b) { var o = el('option'); o.value = b; o.textContent = b || 'all'; br.appendChild(o); });
    bar.appendChild(srch); bar.appendChild(seg.bar); bar.appendChild(br);
    var list = el('div'); list.style.cssText = 'flex:1;overflow:auto;padding:6px';
    wrap.appendChild(bar); wrap.appendChild(list); body.appendChild(wrap);
    var mode = 'history';
    function load() {
      list.innerHTML = '<div class="hint" style="padding:8px">' + T('Loading...') + '</div>';
      localApi('browser', { what: mode, query: srch.value.trim(), browser: br.value || undefined, limit: 50 }).then(function (d) {
        list.innerHTML = ''; (d.rows || []).forEach(function (r) {
          var row = el('div', 'fm-row'); row.style.cursor = 'pointer';
          var when = r.ts > 0 ? new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ') : '';
          row.innerHTML = "<div style='flex:1;overflow:hidden'><div style='overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>" + esc(r.title || r.url) + "</div><div class='hint' style='font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'>[" + esc(r.browser) + "] " + esc(when) + " · " + esc(r.url) + "</div></div>";
          row.addEventListener('click', function () { window.open(r.url, '_blank'); });
          list.appendChild(row);
        });
        if (!list.children.length) list.appendChild(el('div', 'hint', srch.value.trim() ? 'No matches.' : 'Type to search your ' + mode + '.'));
      }).catch(function () { list.innerHTML = '<div class="hint">error</div>'; });
    }
    srch.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });
    br.addEventListener('change', load); seg.select('history');
    win.setMenus([{ label: T('View'), items: [{ label: T('History'), action: function () { seg.select('history'); } }, { label: T('Bookmarks'), action: function () { seg.select('bookmarks'); } }] }]);
  }

  // ---------- per-app chat-window setting (the "is chat needed?" toggle) ----------
  function appChatEnabled(appId, def) { var v = localStorage.getItem('zx_chat_' + appId); return v === null ? !!def : v === '1'; }
  function setAppChat(appId, on) { localStorage.setItem('zx_chat_' + appId, on ? '1' : '0'); }

  // ---------- App: Agent (chat window optional, per the app setting) ----------
  function mountAgent(body, win, agent) {
    body.style.padding = '0';
    var wrap = el('div'); wrap.style.cssText = 'height:100%;display:flex;flex-direction:column';
    var head = el('div', 'agent-head');
    head.appendChild(el('div', 'a-name', agent.label || agent.name));
    head.appendChild(el('div', 'a-sub', Tf('Model: {m}', { m: agent.model || T('(default)') })));
    if (agent.job) { var j = el('div', 'a-sub'); j.textContent = agent.job; head.appendChild(j); }
    var bar = el('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px';
    var toggle = el('button', 'switch' + (appChatEnabled(win.appId, true) ? ' on' : ''), "<span class='knob'></span>");
    toggle.title = T('Toggle chat window for this app');
    var lbl = el('span', 'hint', T('Chat window'));
    var spacer = el('div'); spacer.style.flex = '1';
    var note = el('span', 'hint');
    var runBtn = el('button', 'btn ghost', T('Run job'));
    var delBtn = el('button', 'btn ghost', T('Delete'));
    bar.appendChild(toggle); bar.appendChild(lbl); bar.appendChild(spacer); bar.appendChild(note); bar.appendChild(runBtn); bar.appendChild(delBtn);
    head.appendChild(bar);
    wrap.appendChild(head);
    var content = el('div'); content.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column';
    wrap.appendChild(content);
    body.appendChild(wrap);

    function render() {
      if (win._consoleIv) { clearInterval(win._consoleIv); win._consoleIv = null; }
      content.innerHTML = '';
      if (appChatEnabled(win.appId, true)) buildAgentChat(content, agent);
      else buildAgentConsole(content, agent, win);
    }
    toggle.addEventListener('click', function () {
      var now = !appChatEnabled(win.appId, true);
      setAppChat(win.appId, now); toggle.classList.toggle('on', now); render();
    });
    runBtn.addEventListener('click', function () {
      runBtn.disabled = true; note.textContent = T('Running...');
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run', name: agent.name }) })
        .then(function (d) { runBtn.disabled = false; note.textContent = (d && d.error) ? String(d.error) : (T('Done') + (d.via ? ' · ' + d.via : '')); })
        .catch(function () { runBtn.disabled = false; note.textContent = T('Unreachable'); });
    });
    delBtn.addEventListener('click', function () {
      if (!confirm('Delete agent "' + agent.name + '"?')) return;
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', name: agent.name }) })
        .then(function (d) { if (d && d.agents) agents = d.agents; else loadAgents(); closeWin(win); renderDesktop(); })
        .catch(function () { note.textContent = T('Unreachable'); });
    });
    win.cleanup.push(function () { win.closed = true; if (win._consoleIv) clearInterval(win._consoleIv); });
    win.setMenus([{ label: 'Agent', items: [
      { label: T('Run job'), action: function () { runBtn.click(); } },
      { label: T('Chat window'), action: function () { toggle.click(); } },
      '---',
      { label: T('Delete'), action: function () { delBtn.click(); } }
    ] }]);
    render();
  }

  // Real per-agent chat: each turn calls runAgent(name, task) over REST and shows {reply, via}.
  function buildAgentChat(content, agent) {
    var logKey = 'zx_log_a_' + agent.name;
    var chat = el('div', 'chat');
    var log = el('div', 'chat-log');
    var row = el('div', 'chat-input');
    var ta = el('textarea'); ta.placeholder = T('Message') + ' ' + (agent.label || agent.name) + '...';
    var send = el('button'); send.textContent = T('Send');
    row.appendChild(ta); row.appendChild(send);
    chat.appendChild(log); chat.appendChild(row); content.appendChild(chat);
    function addMsg(who, text, cls, via, persist) { var m = el('div', 'msg ' + cls); m.appendChild(el('div', 'who', who + (via ? ' · via ' + via : ''))); var c = el('div'); c.textContent = text; m.appendChild(c); log.appendChild(m); log.scrollTop = log.scrollHeight; if (persist !== false) pushChatLog(logKey, { who: who, text: text, cls: cls, via: via }); return m; }
    var hist = loadChatLog(logKey);
    if (hist.length) hist.forEach(function (r) { addMsg(r.who, r.text, r.cls, r.via, false); });
    else addMsg(agent.label || agent.name, T('Ask me to do something, or give me a task.'), 'bot', null, false);
    function doSend() {
      var t = ta.value.trim(); if (!t) return; addMsg(T('You'), t, 'user'); ta.value = '';
      var pend = addMsg(agent.label || agent.name, T('thinking...'), 'bot', null, false); send.disabled = true;
      api('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run', name: agent.name, task: t }) })
        .then(function (d) {
          send.disabled = false;
          var c = pend.querySelector('div:last-child'), who = pend.querySelector('.who');
          if (d && d.error) { c.textContent = '(' + d.error + ')'; return; }
          who.textContent = (agent.label || agent.name) + (d.via ? ' · via ' + d.via : '');
          c.textContent = d.reply || T('(no reply)');
          pushChatLog(logKey, { who: agent.label || agent.name, text: d.reply || T('(no reply)'), cls: 'bot', via: d.via });
          if (d.scheduled && d.scheduled.cron) addMsg('System', 'Scheduled: ' + (d.scheduled.note || d.scheduled.cron), 'bot');
          log.scrollTop = log.scrollHeight;
        })
        .catch(function () { send.disabled = false; pend.querySelector('div:last-child').textContent = '(backend unreachable)'; });
    }
    send.addEventListener('click', doSend);
    ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    setTimeout(function () { ta.focus(); }, 50);
  }

  // Headless view: no chat; run-on-demand + live activity feed.
  function buildAgentConsole(content, agent, win) {
    var pad = el('div', 'app-pad');
    pad.appendChild(el('div', 'hint', T('Chat window is off — this agent runs headless: it executes its job on demand or on schedule via the existing agent/skill mechanism. Turn the chat on above to talk to it directly.')));
    var log = el('div', 'chat-log'); log.style.borderTop = '1px solid #eee';
    var empty = el('div', 'empty', T('Recent activity will appear here.')); log.appendChild(empty);
    content.appendChild(pad); content.appendChild(log);
    var since = 0;
    function poll() {
      api('/api/agentmsgs?since=' + since).then(function (d) {
        var arr = Array.isArray(d) ? d : (d && d.messages) || [];
        arr.forEach(function (m) {
          if (m.ts) since = Math.max(since, m.ts);
          if (m.from === agent.name || m.agent === agent.name || m.to === agent.name) {
            if (empty.parentNode) empty.remove();
            var x = el('div', 'msg bot'); x.appendChild(el('div', 'who', m.from || 'agent')); var c = el('div'); c.textContent = m.text || ''; x.appendChild(c); log.appendChild(x); log.scrollTop = log.scrollHeight;
          }
        });
      }).catch(function () {});
    }
    poll(); win._consoleIv = setInterval(function () { if (!win.closed) poll(); }, 4000);
  }

  // ============================================================
  // Desktop icons
  // ============================================================
  var deskIcons = $('#desktop-icons');
  var selectedIcon = null;
  function loadIconPos() { try { return JSON.parse(localStorage.getItem('zx_icons') || '{}'); } catch (e) { return {}; } }
  function saveIconPos(p) { try { localStorage.setItem('zx_icons', JSON.stringify(p)); } catch (e) {} }

  function wireIcon(ic, a) {
    function select() { if (selectedIcon && selectedIcon !== ic) selectedIcon.classList.remove('selected'); ic.classList.add('selected'); selectedIcon = ic; }
    ic.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var sx = e.clientX, sy = e.clientY;
      var sl = parseInt(ic.style.left, 10) || 0, st = parseInt(ic.style.top, 10) || 0;
      var moved = false;
      function mv(ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 4) { moved = true; ic.classList.add('dragging'); select(); }
        if (moved) { ic.style.left = Math.max(0, sl + dx) + 'px'; ic.style.top = Math.max(0, st + dy) + 'px'; }
      }
      function up() {
        document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
        if (moved) {
          ic.classList.remove('dragging');
          var pos = loadIconPos(); pos[a.id] = { x: parseInt(ic.style.left, 10), y: parseInt(ic.style.top, 10) }; saveIconPos(pos);
          ic._moved = true; setTimeout(function () { ic._moved = false; }, 0);
        }
      }
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    ic.addEventListener('click', function (e) { e.stopPropagation(); if (ic._moved) return; select(); });
    ic.addEventListener('dblclick', function () { launchApp(a.id); });
  }

  function renderDesktop() {
    deskIcons.innerHTML = '';
    var pos = loadIconPos();
    var os = document.body.dataset.os;
    var startX = os === 'ubuntu' ? 78 : 16;
    var startY = (os === 'mac' || os === 'ubuntu') ? 40 : 16;
    appList().forEach(function (a, i) {
      var ic = el('div', 'desk-icon');
      ic.appendChild(el('div', 'ico', a.iconSvg));
      ic.appendChild(el('div', 'label', a.name));
      var p = pos[a.id];
      if (p) { ic.style.left = p.x + 'px'; ic.style.top = p.y + 'px'; }
      else { ic.style.left = startX + 'px'; ic.style.top = (startY + i * 96) + 'px'; }
      wireIcon(ic, a);
      deskIcons.appendChild(ic);
    });
    if (!startMenu.classList.contains('hidden')) renderStart($('#start-search-input').value);
  }

  function loadAgents() {
    return api('/api/agents').then(function (d) { agents = Array.isArray(d) ? d : []; renderDesktop(); syncTaskbar(); }).catch(function () {});
  }

  // ============================================================
  // Clock + status + wiring
  // ============================================================
  function tickClock() {
    var d = new Date();
    var hh = d.getHours(), mm = d.getMinutes();
    var tt = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm, dd = d.toLocaleDateString();
    Array.prototype.forEach.call(document.querySelectorAll('.clock-time'), function (e) { e.textContent = tt; });
    Array.prototype.forEach.call(document.querySelectorAll('.clock-date'), function (e) { e.textContent = dd; });
  }
  function pollStatus() {
    api('/api/status').then(function () {
      ['#tray-status', '#tray-status-top'].forEach(function (s) { var t = $(s); if (t) { t.classList.add('ok'); t.title = 'Backend connected'; } });
    }).catch(function () { ['#tray-status', '#tray-status-top'].forEach(function (s) { var t = $(s); if (t) t.classList.remove('ok'); }); });
  }

  $('#start-btn').addEventListener('click', function (e) { e.stopPropagation(); toggleStart(); });
  $('#start-search-input').addEventListener('input', function () { renderStart(this.value); });
  // OS.js-style application menu launcher on the top bar (macOS / Ubuntu) — opens the same categorized menu.
  (function () {
    var left = document.getElementById('topbar-left');
    if (left && !document.getElementById('apps-btn')) {
      var ab = el('button', null, T('Apps')); ab.id = 'apps-btn'; ab.title = T('All apps');
      ab.addEventListener('click', function (e) { e.stopPropagation(); toggleStart(); });
      left.appendChild(ab);
    }
  })();
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#startmenu') && !e.target.closest('#start-btn') && !e.target.closest('#apps-btn')) closeStart();
    if (!e.target.closest('.desk-icon') && selectedIcon) { selectedIcon.classList.remove('selected'); selectedIcon = null; }
    if (openDD && !e.target.closest('.menu-dd') && !e.target.closest('.menu-btn')) closeDD();
  });
  $('#clock').addEventListener('click', function () { launchApp('settings'); });

  // boot
  applyTheme();
  applyMode();
  applyStaticI18n();
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { if (modeChoice() === 'auto') applyMode(); }); } catch (e) {} }
  tickClock(); setInterval(tickClock, 10000);
  pollStatus(); setInterval(pollStatus, 15000);
  renderDesktop();
  // Restore the previous window session once agents are known (agent windows need the list);
  // fall back to opening the default Zamolxis app on a fresh/empty session.
  loadAgents().then(function () { if (!restoreSession()) launchApp('zamolxis'); });
})();
