package com.zhiyin.reader;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // 安卓的返回手势默认直接 finish 掉 Activity，读到一半划一下就退出应用。
    // 这里接管：网页历史里还有上一页就退一页（书架 → 正文 → 返回回到书架），
    // 已经到栈底才把应用丢到后台，而不是杀掉进程。
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        if (getBridge() != null && getBridge().getWebView().canGoBack()) {
          getBridge().getWebView().goBack();
        } else {
          moveTaskToBack(true);
        }
      }
    });
  }
}
