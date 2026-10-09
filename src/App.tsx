import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import AppHeader from './components/AppHeader';
import Home from './pages/Home';
import Admin from './pages/Admin';
import Interpreter from './pages/Interpreter';
import Listener from './pages/Listener';
import Poster from './pages/Poster';
import AdminGuard from './components/AdminGuard';
import InterpreterGuard from './components/InterpreterGuard';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app-container">
        <AppHeader />

        <main className="app-main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/admin" element={<AdminGuard><Admin /></AdminGuard>} />
            <Route path="/admin/poster" element={<AdminGuard><Poster /></AdminGuard>} />
            <Route path="/interpreter" element={<InterpreterGuard><Interpreter /></InterpreterGuard>} />
            <Route path="/listener" element={<Listener />} />
            {/* A mistyped or outdated link used to show an empty page with no way back. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
