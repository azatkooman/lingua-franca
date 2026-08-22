import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Admin from './pages/Admin';
import Interpreter from './pages/Interpreter';
import Listener from './pages/Listener';
import AdminGuard from './components/AdminGuard';
import InterpreterGuard from './components/InterpreterGuard';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app-container">
        <header className="app-header">
          <div className="logo-container">
            <span className="logo-icon">🎙️</span>
            <h1>Lingua<span className="logo-accent">Franca</span></h1>
          </div>
        </header>

        <main className="app-main">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/admin" element={<AdminGuard><Admin /></AdminGuard>} />
            <Route path="/interpreter" element={<InterpreterGuard><Interpreter /></InterpreterGuard>} />
            <Route path="/listener" element={<Listener />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
