import { Route, Routes, useLocation } from "react-router-dom";
import { useEffect } from "react";

import { AppShell } from "./components/AppShell";
import { Placeholder } from "./components/Placeholder";
import { Dashboard } from "./pages/Dashboard";
import { Accruals } from "./pages/Accruals";
import { Usage } from "./pages/Usage";

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
          <Route
            path="projection"
            element={
              <Placeholder
                title="Projection"
                blurb="Pick any date to see the projected PTO balance and any hours forfeited."
              />
            }
          />
          <Route
            path="settings"
            element={
              <Placeholder
                title="Settings"
                blurb="Engine constants, company holidays, and accrual tiers."
              />
            }
          />
          <Route
            path="import"
            element={
              <Placeholder
                title="Import / Export"
                blurb="Load the usage log from a CSV export of the sheet, or back it up."
              />
            }
          />
          <Route
            path="*"
            element={<Placeholder title="Not found" blurb="No such page." />}
          />
        </Route>
      </Routes>
    </>
  );
}
