import type { ConfigProviderProps } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';

export const uiLocale = zhCN;
export const uiTheme: ConfigProviderProps['theme'] = {
  token: {
    colorPrimary: '#365ee9',
    colorInfo: '#365ee9',
    colorBgLayout: '#f5f7fb',
    colorText: '#26344b',
    colorTextSecondary: '#7d8ba2',
    colorBorderSecondary: '#e7ecf4',
    borderRadius: 8,
    fontSize: 14,
    controlHeight: 32,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
};
