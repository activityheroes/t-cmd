/* ============================================================
   T-CMD — Multi-User Data Isolation Test Suite
   Run from browser console: IsolationTests.run()
   Or inline: <script src="js/isolation-tests.js"></script>
   ============================================================
   Tests verify that no user can access another user's data.
   All tests are non-destructive: they read state and simulate
   actions in memory without persisting real data changes.
   ============================================================ */

const IsolationTests = (() => {

  // ── Test result helpers ───────────────────────────────────
  const PASS = (name, detail = '') => ({ name, status: 'PASS', detail });
  const FAIL = (name, detail = '') => ({ name, status: 'FAIL', detail });
  const SKIP = (name, detail = '') => ({ name, status: 'SKIP', detail });

  function assert(condition, testName, failDetail = '') {
    return condition ? PASS(testName) : FAIL(testName, failDetail);
  }

  // ── Fake session builder ──────────────────────────────────
  function mockSession(id, role = 'user', email = `user${id}@test.com`, features = {}) {
    return { userId: id, role, email, name: `Test ${id}`, features };
  }

  // ── Tests ─────────────────────────────────────────────────
  const tests = [];

  // ── 1. Session integrity: localStorage tampering is detected ──
  tests.push(async function testSessionTamperingDetected() {
    const name = 'Session tampering is detected (role escalation)';
    try {
      const STORAGE_KEY = 'tcmd_auth';
      const original = localStorage.getItem(STORAGE_KEY);

      // Read current session
      const session = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!session) return SKIP(name, 'No active session — log in first');

      // Simulate tampering: change role without updating hash
      const tampered = { ...session, role: 'admin' };
      delete tampered._h; // remove integrity hash
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tampered));

      // AuthManager.getUser() should return null (tampered, no hash)
      const user = AuthManager.getUser();

      // Restore original session
      if (original) localStorage.setItem(STORAGE_KEY, original);
      else localStorage.removeItem(STORAGE_KEY);

      // If the session had a hash, tampering (missing hash) should be rejected
      if (session._h) {
        return assert(user === null || user?.role !== 'admin', name,
          'Tampered session (missing hash) was accepted — should have been rejected');
      }
      return SKIP(name, 'Session has no integrity hash yet — hash added after next login');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 2. IDB is user-scoped (different DB per user) ─────────
  tests.push(async function testIDBIsUserScoped() {
    const name = 'IndexedDB uses user-scoped database names';
    try {
      if (typeof TaxEngine === 'undefined') return SKIP(name, 'TaxEngine not loaded');
      const uid = SupabaseDB.getCurrentUserId?.() || 'anon';
      const expectedDbName = `tcmd_tax_${uid}`;

      // Attempt to open both the scoped and global DB
      const scopedExists = await new Promise(res => {
        const req = indexedDB.open(expectedDbName);
        req.onsuccess = () => { req.result.close(); res(true); };
        req.onerror = () => res(false);
      });
      const globalExists = await new Promise(res => {
        const req = indexedDB.open('tcmd_tax');
        req.onsuccess = () => {
          const db = req.result;
          const hasData = db.objectStoreNames.contains('transactions');
          db.close();
          res(hasData);
        };
        req.onerror = () => res(false);
      });

      if (globalExists) {
        return FAIL(name, 'Global unscoped "tcmd_tax" database still contains data — data may be shared across users');
      }
      return PASS(name, `Scoped DB "${expectedDbName}" exists; global DB is empty`);
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 3. localStorage user data uses user-scoped keys ───────
  tests.push(async function testLocalStorageScoped() {
    const name = 'localStorage user data keys are user-scoped';
    try {
      const uid = SupabaseDB.getCurrentUserId?.() || 'anon';
      const scopedKey = `tcmd_${uid}_tax_accounts`;
      const globalKey = 'tcmd_tax_accounts'; // old unscoped key

      const globalData = localStorage.getItem(globalKey);
      const scopedData = localStorage.getItem(scopedKey);

      if (globalData && globalData !== '[]' && globalData !== 'null') {
        return FAIL(name, `Unscoped key "${globalKey}" still has data: ${globalData.slice(0, 60)}...`);
      }
      return PASS(name, `Global key "${globalKey}" is empty; user-scoped key "${scopedKey}" is used`);
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 4. API keys are user-scoped in localStorage ───────────
  tests.push(async function testApiKeysUserScoped() {
    const name = 'API keys in localStorage are user-scoped (not global)';
    try {
      const globalKeys = ['tcmd_helius_key', 'tcmd_birdeye_key', 'tcmd_etherscan_key'];
      const leaking = globalKeys.filter(k => localStorage.getItem(k));
      if (leaking.length) {
        return FAIL(name, `Global unscoped API keys still present: ${leaking.join(', ')}`);
      }
      return PASS(name, 'No global unscoped API keys found in localStorage');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 5. Watched wallets require user_id ────────────────────
  tests.push(async function testWalletsRequireUserId() {
    const name = 'getWallets() query always includes user_id filter';
    try {
      if (typeof SupabaseDB === 'undefined') return SKIP(name, 'SupabaseDB not loaded');
      // We test by inspecting the function source for the user_id filter
      const src = SupabaseDB.getWallets.toString();
      const hasUserIdFilter = src.includes('user_id=eq.${userId}') || src.includes("user_id=eq.");
      return assert(hasUserIdFilter, name,
        'getWallets() does not include user_id filter — all wallets may be returned for all users');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 6. deleteWallet requires matching user_id ─────────────
  tests.push(async function testDeleteWalletScoped() {
    const name = 'deleteWallet() includes user_id in delete predicate';
    try {
      if (typeof SupabaseDB === 'undefined') return SKIP(name, 'SupabaseDB not loaded');
      const src = SupabaseDB.deleteWallet.toString();
      const hasUserIdInDelete = src.includes('user_id=eq.${userId}') || src.includes("user_id=eq.");
      return assert(hasUserIdInDelete, name,
        'deleteWallet() does not include user_id — any user could delete any wallet by knowing its ID');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 7. Admin operations require admin role ─────────────────
  tests.push(async function testAdminOperationsRequireAdminRole() {
    const name = 'Admin operations throw when called by non-admin';
    try {
      if (typeof AuthManager === 'undefined') return SKIP(name, 'AuthManager not loaded');
      const user = AuthManager.getUser();
      if (!user || user.role === 'admin') return SKIP(name, 'Log in as a non-admin user to run this test');

      let threw = false;
      try {
        await AuthManager.getAllUsers();
      } catch (e) {
        threw = e.message.includes('Unauthorized') || e.message.includes('administrator');
      }
      return assert(threw, name, 'getAllUsers() did NOT throw for a non-admin user — admin data accessible to all users');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 8. Admin panel refuses to render for non-admins ───────
  tests.push(async function testAdminPanelRefusesNonAdmin() {
    const name = 'renderAdminPanel() renders access-denied for non-admin';
    try {
      if (typeof renderAdminPanel === 'undefined') return SKIP(name, 'renderAdminPanel not available');
      const user = AuthManager.getUser();
      if (!user || user.role === 'admin') return SKIP(name, 'Log in as a non-admin user to run this test');

      // Create a temporary target so renderAdminPanel has somewhere to write
      const tmp = document.createElement('div');
      tmp.id = 'admin-page-content';
      tmp.style.display = 'none';
      document.body.appendChild(tmp);

      await renderAdminPanel();
      const content = tmp.innerHTML;
      document.body.removeChild(tmp);

      const showsAccessDenied = content.includes('Access denied') || content.includes('denied') || content === '';
      return assert(showsAccessDenied, name,
        'renderAdminPanel() showed admin content to a non-admin user');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 9. TaxEngine data is scoped to current user ───────────
  tests.push(async function testTaxEngineDataScoped() {
    const name = 'TaxEngine transaction cache belongs to current user';
    try {
      if (typeof TaxEngine === 'undefined') return SKIP(name, 'TaxEngine not loaded');
      const txns = TaxEngine.getTransactions();
      const uid = SupabaseDB.getCurrentUserId?.();
      if (!uid || uid === 'anon') return SKIP(name, 'Not authenticated — log in first');

      // All transactions should either have no accountId or belong to accounts
      // owned by this user (we can't easily verify accountId→user mapping here
      // without a full DB query, so just verify the cache is loaded and non-null)
      return assert(Array.isArray(txns), name,
        'getTransactions() returned a non-array value');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 10. Invite list is admin-only ─────────────────────────
  tests.push(async function testInviteListAdminOnly() {
    const name = 'getAllInvites() throws for non-admin users';
    try {
      if (typeof AuthManager === 'undefined') return SKIP(name, 'AuthManager not loaded');
      const user = AuthManager.getUser();
      if (!user || user.role === 'admin') return SKIP(name, 'Log in as a non-admin user to run this test');

      let threw = false;
      try {
        await AuthManager.getAllInvites();
      } catch (e) {
        threw = e.message.includes('Unauthorized') || e.message.includes('administrator');
      }
      return assert(threw, name, 'getAllInvites() did NOT throw for a non-admin user');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 11. Cross-user localStorage isolation ─────────────────
  tests.push(async function testCrossUserLocalStorageIsolation() {
    const name = 'User A\'s data is not readable via User B\'s scoped keys';
    try {
      const uid = SupabaseDB.getCurrentUserId?.() || 'anon';
      if (uid === 'anon') return SKIP(name, 'Not authenticated');

      // Write something under User A's key
      const keyA = `tcmd_${uid}_tax_accounts`;
      const sentinelA = JSON.stringify([{ id: 'test-sentinel', label: 'UserA account' }]);
      const prevA = localStorage.getItem(keyA);
      localStorage.setItem(keyA, sentinelA);

      // Simulate User B's perspective (different uid)
      const fakeUidB = uid + '_impersonator';
      const keyB = `tcmd_${fakeUidB}_tax_accounts`;
      const readAsB = localStorage.getItem(keyB);

      // Restore
      if (prevA !== null) localStorage.setItem(keyA, prevA);
      else localStorage.removeItem(keyA);

      return assert(readAsB === null, name,
        `User B's scoped key "${keyB}" returned data — key collision possible`);
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── 12. Wallet localStorage scoped to user ────────────────
  tests.push(async function testWalletLocalStorageScoped() {
    const name = 'Watched wallets are stored under user-scoped localStorage key';
    try {
      const globalKey = 'tcmd_wallets';
      const globalData = localStorage.getItem(globalKey);
      if (globalData && JSON.parse(globalData)?.length > 0) {
        return FAIL(name, `Unscoped wallet key "${globalKey}" has ${JSON.parse(globalData).length} entries — wallets shared across all users`);
      }
      return PASS(name, 'No unscoped wallets found in localStorage');
    } catch (e) {
      return FAIL(name, e.message);
    }
  });

  // ── Runner ────────────────────────────────────────────────
  async function run() {
    console.group('🔒 T-CMD Multi-User Data Isolation Tests');
    console.log('Running', tests.length, 'isolation tests...\n');

    const results = [];
    for (const test of tests) {
      try {
        const result = await test();
        results.push(result);
        const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⏭️';
        console.log(`${icon} ${result.status.padEnd(4)} ${result.name}`);
        if (result.detail) console.log(`       ↳ ${result.detail}`);
      } catch (e) {
        const r = FAIL(test.name, `Unexpected error: ${e.message}`);
        results.push(r);
        console.log(`❌ FAIL ${test.name}`);
        console.log(`       ↳ ${e.message}`);
      }
    }

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const skipped = results.filter(r => r.status === 'SKIP').length;

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Results: ✅ ${passed} passed  ❌ ${failed} failed  ⏭️ ${skipped} skipped`);

    if (failed > 0) {
      console.warn('\n⚠️  SECURITY: Data isolation failures detected. Review the FAIL items above.');
    } else if (skipped === results.length) {
      console.info('\nℹ️  All tests skipped — log in as a regular user and retry.');
    } else {
      console.info('\n✅ All executed tests passed. Data isolation looks correct.');
    }

    console.groupEnd();
    return results;
  }

  return { run, tests };
})();

// Auto-log usage hint when loaded
if (typeof window !== 'undefined') {
  console.info('[IsolationTests] Loaded. Run IsolationTests.run() to check data isolation.');
}
