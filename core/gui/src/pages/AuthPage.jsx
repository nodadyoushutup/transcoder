import { useState } from 'react';

function LoginForm({ onSubmit, pending, error, switchToRegister }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(identifier.trim(), password);
      }}
    >
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="identifier">
          Username or email
        </label>
        <input
          id="identifier"
          type="text"
          autoComplete="username"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-amber-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-center text-sm text-zinc-400">
        Need an account?{' '}
        <button
          type="button"
          className="font-medium text-amber-400 transition hover:text-amber-300"
          onClick={switchToRegister}
          disabled={pending}
        >
          Register
        </button>
      </p>
    </form>
  );
}

function RegisterForm({ onSubmit, pending, error, switchToLogin }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(username.trim(), email.trim(), password);
      }}
    >
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="reg-username">
          Username
        </label>
        <input
          id="reg-username"
          type="text"
          autoComplete="username"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="reg-email">
          Email
        </label>
        <input
          id="reg-email"
          type="email"
          autoComplete="email"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      <div>
        <label className="block text-left text-sm font-medium text-zinc-300" htmlFor="reg-password">
          Password
        </label>
        <input
          id="reg-password"
          type="password"
          autoComplete="new-password"
          className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-amber-500 focus:outline-none focus:ring focus:ring-amber-500/30"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={pending}
          required
        />
      </div>
      {error ? <p className="text-sm text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
      >
        {pending ? 'Creating account…' : 'Create account'}
      </button>
      <p className="text-center text-sm text-zinc-400">
        Already registered?{' '}
        <button
          type="button"
          className="font-medium text-amber-400 transition hover:text-amber-300"
          onClick={switchToLogin}
          disabled={pending}
        >
          Sign in
        </button>
      </p>
    </form>
  );
}

export default function AuthPage({ mode, setMode, pending, error, onLogin, onRegister, embedded = false }) {
  const content = (
    <div className="w-full max-w-md space-y-6 rounded-2xl border border-zinc-800/80 bg-zinc-900/90 p-10 shadow-2xl">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold text-white">Publex Control</h1>
        <p className="text-sm text-zinc-400">
          {mode === 'login' ? 'Sign in to manage your transcoder.' : 'Create an account to manage your transcoder.'}
        </p>
      </div>
      {mode === 'login' ? (
        <LoginForm
          onSubmit={onLogin}
          pending={pending}
          error={error}
          switchToRegister={() => setMode('register')}
        />
      ) : (
        <RegisterForm
          onSubmit={onRegister}
          pending={pending}
          error={error}
          switchToLogin={() => setMode('login')}
        />
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 px-4 text-zinc-100">
      {content}
    </main>
  );
}
