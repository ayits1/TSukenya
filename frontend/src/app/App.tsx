import { Controls } from '../features/component-lab/Controls';
import './app.css';

export function App() {
  return (
    <div className="tk-root tk-lab">
      <header className="tk-lab-header">
        <a href="https://tsukernya.pp.ua/">Цукерня</a>
        <span>Середовище компонентів</span>
      </header>
      <main>
        <div className="tk-lab-title">
          <p>Основа нового інтерфейсу</p>
          <h1>Робочі компоненти</h1>
          <p>Одна бібліотека для каталогу, конструктора та торговельного обліку.</p>
        </div>
        <section className="tk-lab-panel" aria-labelledby="lab-title">
          <h2 id="lab-title">Поля конструктора</h2>
          <p className="tk-lab-note">Це тестові товари. Зміни тут не записуються до CRM.</p>
          <Controls />
        </section>
      </main>
    </div>
  );
}
