Feature: Daemon fleet management
  Owners can enroll remote daemons, inspect their lifecycle state, re-issue
  one-time enrollment credentials, and remove daemon records.

  Scenario: Register, inspect, re-issue, and unregister a pending daemon
    Given the GUI is showing the daemon fleet
    Then the GUI should show an element with test id "daemon-status-filters" within 10 seconds
    And the GUI should show an element with test id "daemon-register" within 10 seconds
    When I register a uniquely named daemon
    Then the GUI should show an element with test id "daemon-enrollment-token-step" within 10 seconds
    When I click on the element with test id "daemon-enrollment-done"
    Then the registered daemon row should be visible within 15 seconds
    When I click on the element with test id "daemon-status-filter-pending"
    Then the daemon status filter "pending" should be selected within 5 seconds
    And the registered daemon row should be visible within 5 seconds
    When I click on the element with test id "daemon-status-filter-pending"
    Then the daemon status filter "pending" should not be selected within 5 seconds
    When I search for the registered daemon
    Then the registered daemon row should be visible within 5 seconds
    When I open the registered daemon inspector
    Then the GUI should show an element with test id "daemon-inspector" within 5 seconds
    And the GUI should show an element with test id "daemon-inspector-pending" within 5 seconds
    When I click on the element with test id "daemon-inspector-reissue"
    Then the GUI should show an element with test id "daemon-enrollment-token-step" within 10 seconds
    And the GUI should show "Re-issue token" within 5 seconds
    When I click on the element with test id "daemon-enrollment-done"
    Then the GUI should not show an element with test id "daemon-enrollment-token-step" within 5 seconds
    And I click on the element with test id "daemon-inspector-unregister"
    Then the GUI should show "Unregister?" within 5 seconds
    When I click on the element containing text "Unregister?"
    Then the daemon inspector should close within 10 seconds
    And the registered daemon row should disappear within 15 seconds
