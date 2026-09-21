"""图库可剪辑的 Creative Commons 许可及必须保留的条件。"""

import re


def creative_commons_notice(value: object) -> str:
    if not isinstance(value, str):
        return ''
    url = value.replace('http://creativecommons.org/', 'https://creativecommons.org/').rstrip('/') + '/'
    if url in {'https://creativecommons.org/publicdomain/zero/1.0/',
               'https://creativecommons.org/publicdomain/mark/1.0/'}:
        return f'{url} · 保留来源，核对人物、商标等第三方权利'
    match = re.fullmatch(r'https://creativecommons\.org/licenses/(by|by-sa|by-nc|by-nc-sa)/(1\.0|2\.0|2\.5|3\.0|4\.0)/', url)
    if not match:
        return ''
    terms = '需署名、链接许可并说明修改'
    if 'nc' in match[1]:
        terms += '；仅限非商业使用（允许符合许可的个人非商业视频）'
    if 'sa' in match[1]:
        terms += '；改编部分须按相同或兼容许可分享'
    return f'CC {match[1].upper()} {match[2]} · {url} · {terms}'
