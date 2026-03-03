import { Router, Route } from "@solidjs/router";
import { TestCall3 } from "./TestCall3";

export default function App() {
  return (
    <Router>
      <Route path="/" component={TestCall3} />
    </Router>
  );
}
