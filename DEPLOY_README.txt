================================================================
TBD DASHBOARD v2.7.1 - DROPDOWN BUGFIX
DRAG-AND-DROP NETLIFY DEPLOY
================================================================

WHAT CHANGED IN v2.7.1 (vs v2.7):

BUGFIX: Quo Number Assignment dropdown kept closing instantly

ROOT CAUSE:
   The dropdown's click bubbled up to a hidden re-render trigger
   that rebuilt the entire assignments table every time you
   interacted with it. Each rebuild destroyed the open <select>
   element, making it look like the dropdown was opening then
   instantly closing.

FIX (3 layers):
   1. Removed the renderManagedAgents() override that auto-fired
      refreshAgentAssignmentsView() on every internal re-render
   2. Now loads assignments table ONCE when you first navigate
      to Manage Agents, plus manual Refresh button
   3. Added stopPropagation() to dropdown + button + row clicks
      so they no longer bubble to outer handlers
   4. refreshAgentAssignmentsView() now bails out if a dropdown
      is currently focused (extra safety)

EVERYTHING ELSE from v2.7 is unchanged.

================================================================
DEPLOY: Just drag this zip onto Netlify. No SQL changes, no env
var changes. After deploy, hard-refresh dashboard (Ctrl+Shift+R)
and try the dropdown - it should stay open now.
================================================================
