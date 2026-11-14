// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from 'react';
import { useNavigate, Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useAuthStore } from '../stores/authStore';
import { authApi } from '../api/auth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // The service verifies this email/password through the Tier-2 identity
      // capability; the browser only receives the signed SOS session.
      const response = await authApi.login(formData);
      login(response.access_token, response.refresh_token, response.user);
      navigate({ to: '/admin' });
    } catch (err: unknown) {
      if (isAxiosError<{ detail?: string; error?: string }>(err)) {
        const code = err.response?.data?.error;
        if (code === 'demo_auth_disabled') {
          setError(
            'Đăng nhập demo đang tắt. Vui lòng liên hệ quản trị viên để được cấp quyền truy cập.'
          );
        } else if (code === 'identity_not_configured' || code === 'identity_unavailable') {
          setError('Dịch vụ danh tính hiện không khả dụng. Vui lòng thử lại sau.');
        } else if (code === 'invalid_credentials') {
          setError('Email hoặc mật khẩu không đúng.');
        } else {
          setError(err.response?.data?.detail || 'Đăng nhập thất bại. Vui lòng kiểm tra thông tin.');
        }
      } else {
        setError('Đăng nhập thất bại. Vui lòng kiểm tra thông tin.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Đăng nhập tài khoản</CardTitle>
          <CardDescription>Nhập email và mật khẩu để truy cập hệ thống</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="Nhập email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Mật khẩu</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="Nhập mật khẩu"
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
            </Button>

            <p className="text-xs text-slate-500">
              Danh tính được xác minh bởi dịch vụ định danh. Hệ thống chỉ giữ phiên đăng nhập
              đã ký; mật khẩu và token nội bộ không được trả về trình duyệt.
            </p>

            <div className="text-center text-sm">
              <span className="text-gray-600">Chưa có tài khoản? </span>
              <Link to="/register" className="text-blue-600 hover:text-blue-500">
                Đăng ký ngay
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
