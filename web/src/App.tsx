import { Route, Routes, useLocation } from "react-router-dom";
import { useEffect } from "react";

import { AppShell } from "./components/AppShell";
import { Placeholder } from "./components/Placeholder";
import { Dashboard } from "./pages/Dashboard";
import { Accruals } from "./pages/Accruals";
import { Usage } from "./pages/Usage";
import { Projection } from "./pages/Projection";
import { Settings } from "./pages/Settings";
import { Import } from "./pages/Import";

// Scroll to top on every navigation (HANDOFF §7).
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="accruals" element={<Accruals />} />
          <Route path="usage" element={<Usage />} />
          <Route path="projection" element={<Projection />} />
          <Route path="settings" element={<Settings />} />
          <Route path="import" element={<Import />} />
          <Route
            path="*"
            element={<Placeholder title="Not found" blurb="No such page." />}
          />
        </Route>
      </Routes>
    </>
  );
}
