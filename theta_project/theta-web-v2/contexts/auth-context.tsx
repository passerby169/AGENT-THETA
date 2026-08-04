'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: number;
  username: string;
  email?: string;
  full_name?: string;
}

interface SendCodeRequest {
  email: string;
  type: 'register' | 'reset_password';
}

interface VerifyCodeRequest extends SendCodeRequest {
  code: string;
}

type ProfileUpdateRequest = Record<string, unknown>;
type PasswordChangeRequest = Record<string, unknown>;

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  register: (username: string, email: string, password: string, fullName?: string, code?: string) => Promise<void>;
  logout: () => void;
  updateProfile: (data: ProfileUpdateRequest) => Promise<void>;
  changePassword: (data: PasswordChangeRequest) => Promise<void>;
  sendVerificationCode: (data: SendCodeRequest) => Promise<{ message: string; debug_code?: string }>;
  verifyCode: (data: VerifyCodeRequest) => Promise<boolean>;
  refreshUser: () => Promise<void>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const unavailable = async (_request?: unknown): Promise<never> => {
  throw new Error('THETA 2.0 使用本地工作台，不连接一代账号服务。');
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  return (
    <AuthContext.Provider
      value={{
        user: null,
        loading: false,
        login: async () => unavailable(),
        register: async () => unavailable(),
        logout: () => router.push('/'),
        updateProfile: unavailable,
        changePassword: unavailable,
        sendVerificationCode: unavailable,
        verifyCode: async (_data: VerifyCodeRequest) => false,
        refreshUser: async () => undefined,
        isAuthenticated: false,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
