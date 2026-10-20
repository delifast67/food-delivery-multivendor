"""Recette admin réelle sur fixtures MongoDB jetables, sans fournisseur externe."""
import json, sys, re
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

base, result_path, fixture_path, executable = sys.argv[1:]
fixtures = json.loads(Path(fixture_path).read_text())
out = Path(result_path).parent
out.mkdir(parents=True, exist_ok=True)
expect.set_options(timeout=15000)
checks = []
def checked(label):
    checks.append(label)
    print('OK — ' + label, flush=True)

def gql(page, query, variables=None, token=None):
    return page.evaluate('''async ({query, variables, token}) => {
      const r = await fetch('/api/delifast/graphql', {method:'POST',
        headers:{'content-type':'application/json', ...(token?{authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify({query,variables:variables||{}})}); return r.json();
    }''', dict(query=query, variables=variables, token=token))

def success(page, query, variables=None, token=None):
    result = gql(page, query, variables, token)
    assert not result.get('errors'), result.get('errors')
    return result['data']

def login(page):
    page.goto(base + '/delifast')
    page.get_by_label('Email', exact=True).fill('admin@delifast.local')
    page.get_by_label('Mot de passe', exact=True).fill('AdminDemo!2026')
    page.get_by_role('button', name='Se connecter', exact=True).click()
    expect(page.get_by_role('heading', name='Commandes', exact=True)).to_be_visible()

def capture(page, name):
    page.screenshot(path=str(out / name), full_page=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=executable or None,
        args=['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run'])
    external, errors = [], []
    context = browser.new_context(viewport={'width':1280,'height':900}, service_workers='block')
    def guard(route):
        url = route.request.url
        if urlsplit(url).scheme in ('data','blob') or url.startswith(base + '/'):
            route.continue_()
        else:
            external.append(url)
            route.abort('blockedbyclient')
    context.route('**/*', guard)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    login(page)
    admin = page.evaluate("sessionStorage.getItem('delifast-local-session')")
    assert admin
    ids = fixtures['orders']
    paged = fixtures['paged']
    filters = page.locator('section[aria-label="Filtres commandes"]')
    search = page.get_by_role('searchbox', name='Rechercher une commande')
    apply = filters.get_by_role('button', name='Appliquer les filtres', exact=True)
    rows = page.locator('button[aria-label^="Ouvrir la commande "]')
    expect(rows).to_have_count(20)
    assert rows.count() <= 20
    first_page = set(rows.all_inner_texts())
    first_label = rows.first.get_attribute('aria-label')
    page_two = page.get_by_role('button', name='Suivante', exact=True)
    expect(page_two).to_be_enabled()
    page_two.click()
    expect(page.get_by_text('Page 2', exact=False)).to_be_visible()
    expect(page.get_by_role('button', name=first_label, exact=True)).to_have_count(0)
    expect(rows).to_have_count(20)
    second_page = set(rows.all_inner_texts())
    assert first_page.isdisjoint(second_page), (first_page, second_page)
    page.get_by_role('button', name='Précédente', exact=True).click()
    expect(page.get_by_text('Page 1', exact=False)).to_be_visible()
    expect(page.get_by_role('button', name=first_label, exact=True)).to_be_visible()
    checked('pages serveur bornées à 20 sans doublon entre pages')
    # The target is deliberately outside page 1; only an explicit Apply may issue
    # the server-side search request.
    search.fill(paged[0])
    expect(page.get_by_role('button', name='Ouvrir la commande ' + paged[0], exact=True)).to_have_count(0)
    apply.click()
    expect(page.get_by_role('button', name='Ouvrir la commande ' + paged[0], exact=True)).to_be_visible()
    filters.get_by_label('Paiement', exact=True).select_option('PAID')
    filters.get_by_label('Statut', exact=True).select_option('CONFIRMED')
    filters.get_by_label('Restaurant', exact=True).select_option('rest-koudougou')
    apply.click()
    expect(page.get_by_role('button', name='Ouvrir la commande ' + paged[0], exact=True)).to_be_visible()
    page.get_by_role('button', name='Effacer les filtres', exact=True).click()
    filters.get_by_label('Statut', exact=True).select_option('CONFIRMED')
    apply.click()
    checked('recherche serveur hors première page et filtres combinés appliqués explicitement')
    link = page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)
    expect(link).to_be_enabled()
    link.focus(); page.keyboard.press('Enter')
    detail = page.locator('aside[aria-label="Détail de la commande"]')
    expect(detail).to_be_visible()
    # The server accepts the write but its response is lost. No automatic replay.
    lost = {'count':0}
    def lose_order(route):
        if 'transitionOrder(' in (route.request.post_data or ''):
            lost['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_order)
    page.get_by_role('button', name='Passer à ACCEPTED', exact=True).click()
    page.get_by_role('button', name='Confirmer le changement', exact=True).click()
    expect(detail.get_by_text('Résultat à vérifier.', exact=False)).to_be_visible()
    assert lost['count'] == 1
    expect(page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True)).to_have_count(0)
    expect(detail.get_by_role('button', name='Passer à PREPARING', exact=True)).to_be_disabled()
    page.unroute('**/api/delifast/graphql', lose_order)
    detail.get_by_role('button', name='Relire la commande avant de décider', exact=True).click()
    expect(detail.get_by_text('ACCEPTED ·', exact=False)).to_be_visible()
    expect(detail.get_by_role('button', name='Passer à PREPARING', exact=True)).to_be_enabled()
    checked('mutation CONFIRMED acceptée réponse perdue : commande sortie de liste, détail indépendant relu et action réautorisée')
    # A second lost write leaves the detail blocked. A page refresh may succeed,
    # but a failed independent detail read must not clear that safety lock.
    lost_preparing = {'count': 0}
    def lose_preparing(route):
        if 'transitionOrder(' in (route.request.post_data or ''):
            lost_preparing['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_preparing)
    detail.get_by_role('button', name='Passer à PREPARING', exact=True).click()
    page.get_by_role('button', name='Confirmer le changement', exact=True).click()
    expect(detail.get_by_text('Résultat à vérifier.', exact=False)).to_be_visible()
    assert lost_preparing['count'] == 1
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_disabled()
    page.unroute('**/api/delifast/graphql', lose_preparing)
    reload_fail = {'count': 0}
    def fail_detail_reload(route):
        if 'operationsOrder(id:' in (route.request.post_data or ''):
            reload_fail['count'] += 1
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', fail_detail_reload)
    detail.get_by_role('button', name='Relire la commande avant de décider', exact=True).click()
    expect(page.locator('.df-banner[role="status"]')).to_contain_text(re.compile('Failed to fetch|Erreur de lecture du détail'))
    assert reload_fail['count'] == 1
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_disabled()
    # Exercise the 2,000,000-byte client guard on a read. The response is
    # deliberately not a success-shaped payload and no write is attempted.
    def oversized_detail(route):
        if 'operationsOrder(id:' in (route.request.post_data or ''):
            route.fulfill(status=200, headers={'content-type': 'application/json'}, body='x' * 2000001)
        else: route.fallback()
    page.route('**/api/delifast/graphql', oversized_detail)
    page.get_by_role('button', name='Actualiser', exact=True).click()
    expect(page.locator('.df-banner[role="status"]')).to_contain_text('Réponse API trop volumineuse')
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_disabled()
    page.unroute('**/api/delifast/graphql', fail_detail_reload)
    page.unroute('**/api/delifast/graphql', oversized_detail)
    detail.get_by_role('button', name='Relire la commande avant de décider', exact=True).click()
    expect(detail.get_by_text('PREPARING ·', exact=False)).to_be_visible()
    expect(detail.get_by_role('button', name='Passer à READY', exact=True)).to_be_enabled()
    checked('échec de relecture détail et lecture API >2 Mo : verrouillage conservé malgré page chargée, puis reprise explicite sans faux succès ni écriture')
    page.get_by_role('button', name='Support', exact=True).click()
    support = page.locator('section[aria-label="Support"]')
    expect(support.get_by_role('button', name='Recette support 1', exact=True)).to_be_visible()
    support.get_by_role('button', name='Suivante', exact=True).click()
    expect(support.get_by_text('Page 2', exact=False)).to_be_visible()
    support.get_by_role('button', name='Précédente', exact=True).click()
    support.get_by_role('button', name='Recette support 1', exact=True).click()
    ticket = support.locator('aside[aria-label="Détail du ticket"]')
    expect(ticket.get_by_text('Ticket fixture admin uniquement', exact=True)).to_be_visible()
    checked('Support paginé et détail serveur réel')
    mutation = 'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id status version}}'
    # Modifier ailleurs pendant que l’admin lit version 0 : le brouillon doit échouer.
    success(page, mutation, {'id':'admin-ticket-a','v':0,'s':'IN_PROGRESS','n':'Prise en charge concurrente fictive'}, admin)
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Tentative sur version périmée')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True).click()
    expect(support.get_by_text('CONCURRENT_MODIFICATION', exact=False)).to_be_visible()
    expect(ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True)).to_be_disabled()
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Résolution de recette — visible au créateur')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à RESOLVED', exact=True).click()
    expect(support.get_by_text('Statut du ticket mis à jour.', exact=True)).to_be_visible()
    expect(ticket.get_by_text('Ce ticket est résolu', exact=False)).to_be_visible()
    owner = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-a'}, fixtures['restaurantToken'])['staffSupportTicket']
    assert owner['status']=='RESOLVED' and owner['version']==2
    assert owner['history'][-1]['note']=='Résolution de recette — visible au créateur'
    capture(page, 'support-resolved.png')
    checked('conflit Support, relecture obligatoire, résolution et note visible au créateur')
    for role_token in [None, fixtures['restaurantToken'], fixtures['riderToken']]:
        denied = gql(page, '{operationsSupportTickets(limit:20,offset:0){id}}', token=role_token)
        assert denied.get('errors')
        denied = gql(page, mutation, {'id':'admin-ticket-a','v':2,'s':'RESOLVED','n':'Interdit'}, role_token)
        assert denied.get('errors')
    assert success(page, 'query($id:ID!){staffSupportTicket(id:$id){id}}', {'id':'admin-ticket-a'}, fixtures['riderToken'])['staffSupportTicket'] is None
    checked('lecture et transition Support refusées hors ADMIN, isolation du créateur')
    # Réouverture explicite : motif et confirmation, réponse acceptée mais perdue.
    reopen = ticket.get_by_role('button', name='Rouvrir en IN_PROGRESS', exact=True)
    expect(reopen).to_be_disabled()
    ticket.get_by_role('checkbox').check()
    expect(reopen).to_be_disabled()
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Réouverture fictive — problème persistant')
    expect(reopen).to_be_enabled()
    lost_reopen = {'count': 0}
    def lose_reopen(route):
        if 'transitionSupportTicket(' in (route.request.post_data or ''):
            lost_reopen['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_reopen)
    reopen.click()
    expect(ticket.get_by_text('Écriture verrouillée', exact=False)).to_be_visible()
    expect(reopen).to_be_disabled()
    assert lost_reopen['count'] == 1
    page.unroute('**/api/delifast/graphql', lose_reopen)
    # Relire seulement la page ne doit pas autoriser une seconde écriture.
    support.get_by_role('button', name='Relire la page', exact=True).click()
    expect(support.get_by_role('button', name='Relire la page', exact=True)).to_be_enabled()
    expect(reopen).to_be_disabled()
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    reopened = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-a'}, fixtures['restaurantToken'])['staffSupportTicket']
    assert reopened['status'] == 'IN_PROGRESS' and reopened['version'] == 3
    assert len(reopened['history']) == 4
    assert reopened['history'][-1]['note'] == 'Réouverture fictive — problème persistant'
    assert reopened['history'][-2]['note'] == 'Résolution de recette — visible au créateur'
    expect(support.get_by_role('row').filter(has=page.get_by_role('button', name='Recette support 1', exact=True)).get_by_text('IN_PROGRESS', exact=True)).to_be_visible()
    capture(page, 'support-reopened.png')
    checked('réouverture ADMIN : motif et confirmation, réponse perdue sans doublon, relecture détail obligatoire, historique et vue créateur conservés')
    support.get_by_role('button', name='Recette support 2', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True)).to_be_visible()
    lost_support = {'count':0}
    def lose_support(route):
        if 'transitionSupportTicket(' in (route.request.post_data or ''):
            lost_support['count'] += 1
            response = route.fetch()
            assert response.ok
            route.abort('failed')
        else: route.fallback()
    page.route('**/api/delifast/graphql', lose_support)
    ticket.get_by_label('Note (visible par le créateur)', exact=True).fill('Prise en charge avec réponse perdue')
    ticket.get_by_role('checkbox').check()
    ticket.get_by_role('button', name='Passer à IN_PROGRESS', exact=True).click()
    expect(ticket.get_by_text('Écriture verrouillée', exact=False)).to_be_visible()
    assert lost_support['count']==1
    page.unroute('**/api/delifast/graphql', lose_support)
    ticket.get_by_role('button', name='Relire le détail', exact=True).click()
    expect(ticket.get_by_role('button', name='Passer à RESOLVED', exact=True)).to_be_visible()
    accepted = success(page, 'query($id:ID!){staffSupportTicket(id:$id){status version history{note}}}', {'id':'admin-ticket-b'}, fixtures['riderToken'])['staffSupportTicket']
    assert accepted['status']=='IN_PROGRESS' and accepted['version']==1 and len(accepted['history'])==2
    expect(support.get_by_role('row').filter(has=page.get_by_role('button', name='Recette support 2', exact=True)).get_by_text('IN_PROGRESS', exact=True)).to_be_visible()
    checked('réponse Support perdue : un seul événement, verrouillage puis relecture explicite')
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'débordement horizontal global'
    capture(page, 'admin-support-390.png')
    page.get_by_role('button', name='Commandes', exact=True).click()
    page.get_by_role('button', name='Effacer les filtres', exact=True).click()
    page.get_by_role('button', name='Ouvrir la commande ' + ids[0], exact=True).click()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'débordement commandes'
    capture(page, 'admin-orders-390.png')
    page.get_by_role('button', name='Support', exact=True).click()
    support.get_by_role('button', name='Recette support 1', exact=True).click()
    expect(ticket.get_by_text('Ticket fixture admin uniquement', exact=True)).to_be_visible()
    page.get_by_role('button', name='Effacer les données / quitter', exact=True).click()
    expect(page.get_by_label('Email', exact=True)).to_be_visible()
    expect(page.get_by_text('Ticket fixture admin uniquement', exact=True)).to_have_count(0)
    assert page.evaluate("sessionStorage.getItem('delifast-local-session')") is None
    capture(page, 'admin-logout.png')
    checked('petit écran 390px sans débordement global et purge à la déconnexion')
    assert not external, external
    assert not errors, errors
    checked('aucune requête externe ni erreur JavaScript')
    Path(result_path).write_text(json.dumps({'checks':checks,'count':len(checks),'screenshots':[str(x) for x in out.glob('*.png')]}, ensure_ascii=False, indent=2)+'\n')
    browser.close()
